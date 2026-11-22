#!/bin/sh
# Draws the evaluation sample from the benchmark's questions (knowledge/data/benchmark/qa.jsonl, from
# knowledge/fetch.sh): only questions whose label is in the corpus manifest, stratified by question type with the
# counts in evaluation/sample.json, each stratum chosen by a seeded shuffle of its sorted qids. Writes
# evaluation/data/sample.jsonl (ignored: it holds question text) and fails if the draw differs from the list of qids
# committed in evaluation/sample.json.
#
#   evaluation/sample.sh             draw, and check against the committed list
#   evaluation/sample.sh --record    draw, and write the list and the files' hashes into evaluation/sample.json
#
# Exit codes: 0 the sample is written; 2 could not run, or the draw differs from the committed list.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

mode=ro
record=
case "${1:-}" in
  '') ;;
  --record)
    mode=rw
    record=--record
    ;;
  *)
    say "usage: evaluation/sample.sh [--record]"
    exit 2
    ;;
esac

build_image
# shellcheck disable=SC2086 # $record is empty or one word.
run_tool "$mode" sample --qa /repo/knowledge/data/benchmark/qa.jsonl --manifest /repo/knowledge/corpus/manifest.json \
  --settings /repo/evaluation/sample.json --out /repo/evaluation/data/sample.jsonl $record
