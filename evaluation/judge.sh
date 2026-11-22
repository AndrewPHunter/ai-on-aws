#!/bin/sh
# Has a judge model grade each answerable question the agent answered in one run: correct, partly correct or
# incorrect, with one sentence of reason. Runs on the operator's machine, because the judge is reached through a
# command-line tool with the operator's own login (evaluation/judge/codex.sh, the only adapter).
#
#   evaluation/judge.sh <run-name> [--retry-failed]
#   evaluation/judge.sh <run-name> --check <n>     writes judge-check.csv: n judged items for a person to grade
#
# Three steps: the pinned image writes one request file per question still to judge (question, reference, reply with
# its citation markers removed, and nothing else); this machine calls the adapter for each, at most 4 at once, each
# within 300 s (evaluation/judge/call-all.sh); the pinned image reads the verdicts back into judgments.jsonl and
# writes judge.json (the judge, its model and effort, and the prompt's hash). A call that fails or answers outside the
# schema is recorded as a failure and counted. Started again, it asks only about questions with no judgment; with
# --retry-failed, also those whose judging failed.
#
# Exit codes: 0 every question is judged; 1 some judge calls failed; 2 could not run.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

usage() {
  say "usage: evaluation/judge.sh <run-name> [--retry-failed | --check <n>]"
  exit 2
}

[ "$#" -ge 1 ] || usage
run_name=$1
check_run_name "$run_name"
shift
run_dir="/repo/evaluation/data/runs/$run_name"

# The adapter, its parallel calls and each call's time limit.
ADAPTER="$evaluation_dir/judge/codex.sh"
PARALLEL=4
CALL_TIMEOUT_SECONDS=300

if [ "${1:-}" = --check ]; then
  [ "$#" -eq 2 ] || usage
  build_image
  run_tool ro judge-check --sample /repo/evaluation/data/sample.jsonl --run-dir "$run_dir" --count "$2"
  exit $?
fi

retry=
case "${1:-}" in
  '') ;;
  --retry-failed) retry=--retry-failed ;;
  *) usage ;;
esac

build_image
# shellcheck disable=SC2086 # $retry is empty or one word.
run_tool ro judge-prepare --sample /repo/evaluation/data/sample.jsonl --run-dir "$run_dir" $retry

pending="$evaluation_dir/data/runs/$run_name/judge-pending"
if ! "$ADAPTER" --describe >"$pending/describe.json"; then
  say "the judge adapter could not describe itself"
  exit 2
fi
"$evaluation_dir/judge/call-all.sh" "$pending" "$ADAPTER" "$PARALLEL" "$CALL_TIMEOUT_SECONDS"

run_tool ro judge-collect --run-dir "$run_dir"
