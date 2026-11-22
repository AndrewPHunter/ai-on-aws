#!/bin/sh
# The judge adapter for Codex: reads one JSON request on standard input (instructions, question, reference, reply)
# and writes one JSON verdict on standard output, in the schema of the rubric the request was written for (the schema
# file is the argument: evaluation/judge/verdict.schema.json for completeness, answers-question.schema.json for
# answers-question). Runs on the operator's machine with the operator's own Codex login; it is never run in a
# container.
#
#   evaluation/judge/codex.sh <schema-file> < request.json > verdict.json
#   evaluation/judge/codex.sh --describe      prints {"judge", "model", "effort"} for the judge file
#
# The request is passed to Codex as the prompt, as it is. Codex runs in an empty folder, read-only, with no git
# repository, no user configuration and no rules, keeps no session, and must answer in the schema. Its own output
# goes nowhere: only the verdict file is written to standard output. Exit code: Codex's, or 2 when it could not run.
set -eu

# The judge's settings.
MODEL=gpt-6-astra
EFFORT=high

if [ "${1:-}" = --describe ]; then
  printf '{"judge":"codex","model":"%s","effort":"%s"}\n' "$MODEL" "$EFFORT"
  exit 0
fi

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  printf '%s\n' "usage: evaluation/judge/codex.sh <schema-file> < request.json" >&2
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
  -o "$work/verdict.json" --color never - >/dev/null 2>&1

cat "$work/verdict.json"
