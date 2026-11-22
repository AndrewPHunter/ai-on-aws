#!/bin/sh
# Scores one run, in a container with no network, against its own sample variant's file: outcomes, declining, the
# right label, citations and retrieval against the benchmark's references by section, numbers, effort, every judge
# rubric the run has judgments for, and the retrieval measures and "answers the question, uncontradicted" in thirds of
# wording overlap. Writes evaluation/data/runs/<run-name>/scores.json and prints the table: counts and shares, never
# text.
#
#   evaluation/score.sh <run-name>
#
# Exit codes: 0 scored; 2 could not run (among others: the run's sample variant file has changed since the run).
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

if [ "$#" -ne 1 ]; then
  say "usage: evaluation/score.sh <run-name>"
  exit 2
fi
check_run_name "$1"

build_image
run_tool ro score --sample /repo/evaluation/data/sample.jsonl --run-dir "/repo/evaluation/data/runs/$1" \
  --knowledge-data /repo/knowledge/data
