#!/bin/sh
# Compares two scored runs of the same sample, question by question: for each yes-or-no measure, both right, only A,
# only B, neither, and the exact two-sided sign test on the two middle counts. Prints the table and writes it as
# compare-<run-a>.json beside run B.
#
#   evaluation/compare.sh <run-a> <run-b>
#
# Exit codes: 0 compared; 2 could not run (a run not scored, or the runs made on different samples).
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

if [ "$#" -ne 2 ]; then
  say "usage: evaluation/compare.sh <run-a> <run-b>"
  exit 2
fi
check_run_name "$1"
check_run_name "$2"

build_image
run_tool ro compare --run-a "/repo/evaluation/data/runs/$1" --run-b "/repo/evaluation/data/runs/$2"
