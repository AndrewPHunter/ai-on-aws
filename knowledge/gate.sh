#!/bin/sh
# Checks the retrieval path of a running stack whose index has been built, from inside its network: the token
# check, the index's count, both tools, the refusals, and a rough measure of how often the right section comes
# back. See knowledge/README.md, "The gate".
#
#   knowledge/gate.sh <compose-project>
#
# Exit codes: 0 every statement holds, 1 a statement does not hold (the report lists each), 2 could not run, with
# the reason on standard error. A report goes to standard output only with exit 0 or 1, and nothing else ever does.
# Neither the report nor standard error carries a password, token or label text: identifiers, codes and counts.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  say "usage: knowledge/gate.sh <compose-project>"
  exit 2
fi
network="$1_default"
identity_env="$repo_dir/platform/identity/.env"

if [ ! -f "$identity_env" ]; then
  say "platform/identity/.env does not exist. Run platform/identity/setup.sh first."
  exit 2
fi

# The build's output goes to standard error, so standard output carries the report and nothing else.
build_image
if ! docker network inspect --format '{{.Name}}' "$network" >/dev/null 2>&1; then
  say "there is no network $network: is the stack running in compose project $1?"
  exit 2
fi

report=$(mktemp)
trap 'rm -f "$report"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The image (from lib.sh) and the compose project are both named for this checkout, so a gate run from one
# checkout never runs an image another checkout built.
gate_project="ai-on-aws-knowledge-gate-$checkout"
say "image $KNOWLEDGE_IMAGE"

rc=0
env KNOWLEDGE_IMAGE="$KNOWLEDGE_IMAGE" KNOWLEDGE_GATE_NETWORK="$network" \
  docker compose -p "$gate_project" -f "$knowledge_dir/gate/compose.yaml" --env-file "$identity_env" \
  run --rm -T --user "$(id -u):$(id -g)" gate >"$report" || rc=$?
if { [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; } && [ -s "$report" ]; then
  cat "$report"
  exit "$rc"
fi
say "the gate produced no report (exit $rc): Compose failed before the gate ran, or the gate could not run."
exit 2
