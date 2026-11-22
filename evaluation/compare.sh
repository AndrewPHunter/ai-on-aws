#!/bin/sh
# Compares two scored runs made on the same set of questions, question by question: for each yes-or-no measure, both
# right, only A, only B, neither, and the exact two-sided sign test on the two middle counts; then the same for the
# retrieval measures and "answers the question, uncontradicted" within each third of wording overlap, as run A's scores
# cut them. The runs may be on different sample variants (the original and the reworded); it says which it compared.
# Prints the table and writes it as compare-<run-a>.json beside run B (compare-<run-a>-only-reworded.json with
# --only-reworded).
#
#   evaluation/compare.sh <run-a> <run-b> [--only-reworded]
#
# --only-reworded restricts the comparison to the questions actually reworded; one of the runs must be on the
# reworded variant.
#
# Exit codes: 0 compared; 2 could not run (a run not scored, the runs on different sets of questions, or on the same
# variant with different files).
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

usage() {
  say "usage: evaluation/compare.sh <run-a> <run-b> [--only-reworded]"
  exit 2
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then usage; fi
check_run_name "$1"
check_run_name "$2"
only=
if [ "$#" -eq 3 ]; then
  [ "$3" = --only-reworded ] || usage
  only=--only-reworded
fi

build_image
# shellcheck disable=SC2086 # $only is empty or one word.
run_tool ro compare --run-a "/repo/evaluation/data/runs/$1" --run-b "/repo/evaluation/data/runs/$2" $only
