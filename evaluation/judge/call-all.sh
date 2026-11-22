#!/bin/sh
# Calls a model adapter (the judge's, or the rewriter's) once for each request file in a folder, at most <parallel> at
# once, on the operator's machine. The adapter is run as `<adapter> <schema-file>`, the schema its answer must keep to,
# with the request on standard input. For each <name>.json it writes <name>.out (the adapter's standard output: one
# JSON answer) and <name>.status (the adapter's exit code, or "timeout"). The adapter's standard error is discarded: it
# can carry the question or the reply. Nothing here prints any of them.
#
#   evaluation/judge/call-all.sh <pending-dir> <adapter> <parallel> <timeout-seconds> <schema-file>
#
# A request that already has a .status file is not sent again. Exit code 0 when every request has a status, 2 when
# it could not run. Needs only a POSIX shell, xargs, sleep and kill.
set -eu

usage() {
  printf '%s\n' "usage: evaluation/judge/call-all.sh <pending-dir> <adapter> <parallel> <timeout-seconds> <schema-file>" >&2
  exit 2
}

# One call, with a watchdog that ends it after the time limit.
call_one() {
  name=$1
  if [ -f "$pending/$name.status" ]; then
    return 0
  fi
  rm -f "$pending/$name.timeout"
  "$adapter" "$schema" <"$pending/$name.json" >"$pending/$name.out" 2>/dev/null &
  pid=$!
  # The watchdog holds none of this script's output open, and takes its sleep with it when it is ended.
  (
    sleep "$limit" &
    sleeper=$!
    trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
    wait "$sleeper"
    if kill "$pid" 2>/dev/null; then printf 'timeout\n' >"$pending/$name.timeout"; fi
  ) >/dev/null 2>&1 &
  watchdog=$!
  rc=0
  wait "$pid" || rc=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  if [ -f "$pending/$name.timeout" ]; then
    printf 'timeout\n' >"$pending/$name.status"
  else
    printf '%s\n' "$rc" >"$pending/$name.status"
  fi
}

# xargs runs this script again for each name, at most <parallel> at once.
if [ "${CALL_ALL_ONE:-}" = 1 ]; then
  # Some xargs run the command once with no name when there is nothing to call: nothing to do then.
  [ "$#" -ne 5 ] || exit 0
  [ "$#" -eq 6 ] || usage
  pending=$1
  adapter=$2
  limit=$4
  schema=$5
  call_one "$6"
  exit 0
fi

[ "$#" -eq 5 ] || usage
pending=$1
adapter=$2
parallel=$3
limit=$4
schema=$5

if [ ! -d "$pending" ] || [ ! -x "$adapter" ] || [ ! -f "$schema" ]; then
  printf '%s\n' "call-all.sh: the pending folder, the adapter or the schema file does not exist" >&2
  exit 2
fi

for request in "$pending"/*.json; do
  [ -f "$request" ] || continue
  name=$(basename -- "$request" .json)
  if [ "$name" = index ] || [ "$name" = describe ]; then
    continue
  fi
  printf '%s\n' "$name"
done | CALL_ALL_ONE=1 xargs -n 1 -P "$parallel" "$0" "$pending" "$adapter" "$parallel" "$limit" "$schema"
