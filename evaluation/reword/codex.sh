#!/bin/sh
# The rewriter adapter for Codex: reads one JSON request on standard input and writes one JSON answer on standard
# output, in the schema file given as the argument. Two kinds of request reach it: a rewrite (instructions, question,
# drug_name; answered in evaluation/reword/rewrite.schema.json) and a check (instructions, original, rewrite; answered in
# evaluation/reword/same.schema.json). Runs on the operator's machine with the operator's own Codex login; it is never
# run in a container.
#
#   evaluation/reword/codex.sh <schema-file> < request.json > answer.json
#   evaluation/reword/codex.sh --describe      prints {"rewriter", "model", "effort"} for the reworded file's record
#
# The request is passed to Codex as the prompt, as it is. Codex runs in an empty folder, read-only, with no git
# repository, no user configuration and no rules, keeps no session, and must answer in the schema. Its own output
# goes nowhere: only the answer file is written to standard output. Exit code: Codex's, or 2 when it could not run.
set -eu

# The rewriter's settings.
MODEL=gpt-6-astra
EFFORT=high

if [ "${1:-}" = --describe ]; then
  printf '{"rewriter":"codex","model":"%s","effort":"%s"}\n' "$MODEL" "$EFFORT"
  exit 0
fi

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  printf '%s\n' "usage: evaluation/reword/codex.sh <schema-file> < request.json" >&2
  exit 2
fi
schema=$(CDPATH='' cd -- "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1")

if ! command -v codex >/dev/null 2>&1; then
  printf '%s\n' "codex.sh: the codex command was not found on PATH" >&2
  exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/empty"

codex exec -m "$MODEL" -c "model_reasoning_effort=\"$EFFORT\"" --sandbox read-only --skip-git-repo-check \
  --ephemeral --ignore-user-config --ignore-rules -C "$work/empty" --output-schema "$schema" \
  -o "$work/answer.json" --color never - >/dev/null 2>&1

cat "$work/answer.json"
