#!/bin/sh
# Has a judge model grade each answerable question the agent answered in one run, under one rubric, with one sentence
# of reason. Runs on the operator's machine, because the judge is reached through a command-line tool with the
# operator's own login (evaluation/judge/codex.sh, the only adapter).
#
#   evaluation/judge.sh <run-name> [--rubric <name>] [--retry-failed]
#   evaluation/judge.sh <run-name> [--rubric <name>] --check <n>   writes judge-check-<rubric>.csv: n judged items for
#                                                                  a person to grade
#
# The rubrics: answers-question (the default: does the reply answer what the question asks, does it state anything the
# reference contradicts, how much of the reference it covers) and completeness (the first rubric: correct, partly
# correct or incorrect against every fact of the reference).
#
# Three steps: the pinned image writes one request file per question still to judge (the rubric's instructions, the
# question the run sent, the reference, the reply with its citation markers removed, and nothing else); this machine
# calls the adapter for each with the rubric's schema file, at most 4 at once, each within 300 s
# (evaluation/judge/call-all.sh); the pinned image reads the verdicts back into judgments-<rubric>.jsonl and writes
# judge-<rubric>.json (the judge, its model and effort, the rubric and its instructions' hash). A call that fails or
# answers outside the rubric's schema is recorded as a failure and counted. Started again, it asks only about
# questions with no judgment under the rubric; with --retry-failed, also those whose judging failed.
#
# Exit codes: 0 every question is judged; 1 some judge calls failed; 2 could not run.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

usage() {
  say "usage: evaluation/judge.sh <run-name> [--rubric completeness|answers-question] [--retry-failed | --check <n>]"
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

rubric=answers-question
retry=
check=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rubric)
      [ "$#" -ge 2 ] || usage
      rubric=$2
      shift 2
      ;;
    --retry-failed)
      retry=--retry-failed
      shift
      ;;
    --check)
      [ "$#" -ge 2 ] || usage
      check=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
if [ -n "$retry" ] && [ -n "$check" ]; then usage; fi

# Each rubric's verdict schema, handed to the adapter.
case "$rubric" in
  completeness) schema="$evaluation_dir/judge/verdict.schema.json" ;;
  answers-question) schema="$evaluation_dir/judge/answers-question.schema.json" ;;
  *) usage ;;
esac

if [ -n "$check" ]; then
  build_image
  run_tool ro judge-check --sample /repo/evaluation/data/sample.jsonl --run-dir "$run_dir" --rubric "$rubric" --count "$check"
  exit $?
fi

build_image
# shellcheck disable=SC2086 # $retry is empty or one word.
run_tool ro judge-prepare --sample /repo/evaluation/data/sample.jsonl --run-dir "$run_dir" --rubric "$rubric" $retry

pending="$evaluation_dir/data/runs/$run_name/judge-pending-$rubric"
if ! "$ADAPTER" --describe >"$pending/describe.json"; then
  say "the judge adapter could not describe itself"
  exit 2
fi
"$evaluation_dir/judge/call-all.sh" "$pending" "$ADAPTER" "$PARALLEL" "$CALL_TIMEOUT_SECONDS" "$schema"

run_tool ro judge-collect --run-dir "$run_dir" --rubric "$rubric"
