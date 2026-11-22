#!/bin/sh
# Writes the reworded variant of the sample, evaluation/data/sample-reworded.jsonl: the same questions (same qid,
# answer and references), with each answerable question's text rewritten by a model as a clinician or pharmacist would
# ask it, and refusal questions copied unchanged. Runs on the operator's machine, because the rewriter is reached
# through a command-line tool with the operator's own login (evaluation/reword/codex.sh, the only adapter).
#
#   evaluation/reword.sh              writes the reworded sample, and sample-reworded.json (the rewriter, the
#                                     instructions' hashes, the file's hash, the counts and the wording overlap)
#   evaluation/reword.sh --check <n>  writes evaluation/data/reword-check.csv: n original and reworded pairs, drawn by
#                                     seed, for a person to read
#
# The same three steps as judge.sh, twice: once for the rewrites, once for the checks. The pinned image writes one
# request per answerable question (the question and the drug's name, and nothing else); this machine calls the adapter
# for each, at most 4 at once, each within 300 s (evaluation/judge/call-all.sh); the image reads the rewrites back,
# settles those that failed or lost the drug's name, and writes one check request for each other (the original and the
# rewrite, and nothing else); this machine calls the adapter again; the image reads the checks back and writes the
# file. A rewrite is used only when the checker says it asks the same thing; otherwise the question keeps its original
# text, counted with the reason. It prints counts and overlaps, never text.
#
# It refuses to run when evaluation/data/sample-reworded.jsonl exists: runs are pinned to that file by its hash.
#
# Exit codes: 0 the file is written; 1 the file is written, and some model calls failed (those questions keep their
# original text); 2 could not run.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

usage() {
  say "usage: evaluation/reword.sh [--check <n>]"
  exit 2
}

# The adapter, its parallel calls and each call's time limit.
ADAPTER="$evaluation_dir/reword/codex.sh"
PARALLEL=4
CALL_TIMEOUT_SECONDS=300

sample=/repo/evaluation/data/sample.jsonl
qa=/repo/knowledge/data/benchmark/qa.jsonl

if [ "${1:-}" = --check ]; then
  [ "$#" -eq 2 ] || usage
  build_image
  run_tool ro reword-check --sample "$sample" --count "$2"
  exit $?
fi
[ "$#" -eq 0 ] || usage

if [ ! -f "$evaluation_dir/data/sample.jsonl" ]; then
  say "evaluation/data/sample.jsonl does not exist. Run evaluation/sample.sh first."
  exit 2
fi
if [ -e "$evaluation_dir/data/sample-reworded.jsonl" ]; then
  say "evaluation/data/sample-reworded.jsonl exists already: runs may be pinned to it. Move it away first to reword again."
  exit 2
fi

pending_host="$evaluation_dir/data/reword-pending"
pending=/repo/evaluation/data/reword-pending

build_image
run_tool ro reword-prepare --sample "$sample" --qa "$qa" --pending "$pending"
if ! "$ADAPTER" --describe >"$pending_host/describe.json"; then
  say "the rewriter adapter could not describe itself"
  exit 2
fi
"$evaluation_dir/judge/call-all.sh" "$pending_host/rewrite" "$ADAPTER" "$PARALLEL" "$CALL_TIMEOUT_SECONDS" \
  "$evaluation_dir/reword/rewrite.schema.json"

run_tool ro reword-check-prepare --sample "$sample" --qa "$qa" --pending "$pending"
"$evaluation_dir/judge/call-all.sh" "$pending_host/check" "$ADAPTER" "$PARALLEL" "$CALL_TIMEOUT_SECONDS" \
  "$evaluation_dir/reword/same.schema.json"

run_tool ro reword-collect --sample "$sample" --qa "$qa" --pending "$pending"
