#!/bin/sh
# Plays the committed attack, control and fault cases (evaluation/attacks/cases.json) against a running stack, from a
# container on its network: each case is sent through the web client as the signed-in person it names, the truth is
# read from the case system as riley.reviewer, and each case is judged in code. Writes one line per case to
# evaluation/data/attacks/<run-name>/results.jsonl and prints a table of counts. See docs/architecture/evaluation.md,
# "Attack, control and fault cases".
#
#   evaluation/attacks.sh <compose-project> <run-name> [--fault case-system|knowledge]
#
# It changes the stack it is run against: it enters about 60 inquiries as dana.desk and morgan.medinfo and opens
# cases from them, all with invented people and medicines. It is for a trial stack: start a fresh one, with the index
# built and a model server, and run it there. Started again with the same run name it refuses, since the stack has
# changed since; give each run, and each --fault run, its own name.
#
# Without --fault: the victim's report first, then every attack and control case and the sent-twice faults, one at a
# time. With --fault <service>: that service of the stack (case-system or knowledge) is stopped with Compose, only the
# cases run while it is stopped are played, and the service is started again whatever happened. It refuses to run
# when the service is not running to begin with.
#
# <compose-project> is the compose project the whole stack runs in; the runner joins <compose-project>_default, and
# --fault stops and starts the service in that project with the repository's compose.yaml.
#
# Exit codes: 0 every case decided by code held and every control held; 1 one did not (the table says which); 2 could
# not run. It prints case ids, verdicts, counts and kinds: never the text of a message, a reply or a case.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

usage() {
  say "usage: evaluation/attacks.sh <compose-project> <run-name> [--fault case-system|knowledge]"
  exit 2
}

if [ "$#" -lt 2 ] || [ -z "$1" ]; then usage; fi
project=$1
network="$1_default"
check_run_name "$2"
run_name=$2
shift 2
part=main
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = --fault ] || usage
  case "$2" in
    case-system | knowledge) part=$2 ;;
    *) usage ;;
  esac
fi

identity_env="$repo_dir/platform/identity/.env"
run_dir="$evaluation_dir/data/attacks/$run_name"
if [ ! -f "$identity_env" ]; then
  say "platform/identity/.env does not exist. Run platform/identity/setup.sh first."
  exit 2
fi
if [ -e "$run_dir" ]; then
  say "evaluation/data/attacks/$run_name exists already: an attack run changes the stack, so it is made once, on a fresh stack, under a new name."
  exit 2
fi

build_image
if ! docker network inspect --format '{{.Name}}' "$network" >/dev/null 2>&1; then
  say "there is no network $network: is the stack running in compose project $project?"
  exit 2
fi

stack_compose() {
  docker compose -p "$project" -f "$repo_dir/compose.yaml" "$@"
}

stopped=no
start_again() {
  if [ "$stopped" = yes ]; then
    stopped=no
    say "starting $part again"
    if ! stack_compose start "$part" >&2; then
      say "starting $part again failed: start it by hand (docker compose -p $project start $part)."
      exit 2
    fi
  fi
}
trap start_again EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$part" != main ]; then
  if ! running=$(stack_compose ps --status running --services); then
    say "Compose could not list the running services of project $project."
    exit 2
  fi
  if ! printf '%s\n' "$running" | grep -qx "$part"; then
    say "the service $part is not running in project $project: the fault run needs it running to begin with."
    exit 2
  fi
  say "stopping $part"
  if ! stack_compose stop "$part" >&2; then
    say "stopping $part failed."
    stopped=yes
    exit 2
  fi
  stopped=yes
fi

mkdir -p -- "$run_dir"
rc=0
env EVALUATION_IMAGE="$EVALUATION_IMAGE" EVALUATION_NETWORK="$network" \
  docker compose -p "ai-on-aws-evaluation-$checkout" -f "$evaluation_dir/compose.yaml" --env-file "$identity_env" \
  run --rm -T --user "$(id -u):$(id -g)" attacks node evaluation/src/main.ts attacks \
  --cases /repo/evaluation/attacks/cases.json --run-dir "/repo/evaluation/data/attacks/$run_name" --part "$part" \
  --client-url http://client:3000 --identity-url http://identity:8080 \
  --browser-client-url http://localhost:3000 --browser-identity-url http://localhost:8090 || rc=$?
# Compose also exits 1 when it fails before the runner starts, so a 1 counts only with results written.
if [ "$rc" -eq 1 ] && [ ! -s "$run_dir/results.jsonl" ]; then
  say "the runner wrote no results (exit 1): Compose failed before it ran, or it could not run."
  rc=2
fi
# Any other code is Compose's or Docker's own (125, 137 and so on): the run could not be made.
if [ "$rc" -gt 2 ]; then
  say "Compose or Docker ended the run with exit $rc."
  rc=2
fi
start_again
exit "$rc"
