#!/bin/sh
# Sends every sampled question to the label expert of a running stack, from a container on its network, as a client
# does: the agent contract's request with a real access token (dana.desk, signed in as the gates do), at most 4 at
# once. Stores each response whole in evaluation/data/runs/<run-name>/responses.jsonl, and the run file run.json.
#
#   evaluation/run.sh <compose-project> <run-name> [--retry-failed]
#
# Started again, it sends only questions with no record; with --retry-failed, also those whose call failed.
# Exit codes: 0 every question has a response; 1 some calls failed (each recorded with its reason); 2 could not run,
# or the responses reported more than one search strategy. It prints counts, never a question or a reply.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || [ -z "$1" ]; then
  say "usage: evaluation/run.sh <compose-project> <run-name> [--retry-failed]"
  exit 2
fi
network="$1_default"
check_run_name "$2"
retry=
if [ "$#" -eq 3 ]; then
  if [ "$3" != --retry-failed ]; then
    say "usage: evaluation/run.sh <compose-project> <run-name> [--retry-failed]"
    exit 2
  fi
  retry=--retry-failed
fi

AGENT_URL=http://expert:8080
identity_env="$repo_dir/platform/identity/.env"

if [ ! -f "$identity_env" ]; then
  say "platform/identity/.env does not exist. Run platform/identity/setup.sh first."
  exit 2
fi
if [ ! -f "$evaluation_dir/data/sample.jsonl" ]; then
  say "evaluation/data/sample.jsonl does not exist. Run evaluation/sample.sh first."
  exit 2
fi

build_image
if ! docker network inspect --format '{{.Name}}' "$network" >/dev/null 2>&1; then
  say "there is no network $network: is the stack running in compose project $1?"
  exit 2
fi
mkdir -p -- "$evaluation_dir/data/runs/$2"

rc=0
# shellcheck disable=SC2086 # $retry is empty or one word.
env EVALUATION_IMAGE="$EVALUATION_IMAGE" EVALUATION_NETWORK="$network" \
  docker compose -p "ai-on-aws-evaluation-$checkout" -f "$evaluation_dir/compose.yaml" --env-file "$identity_env" \
  run --rm -T --user "$(id -u):$(id -g)" runner node evaluation/src/main.ts run \
  --sample /repo/evaluation/data/sample.jsonl --run-dir "/repo/evaluation/data/runs/$2" --agent-url "$AGENT_URL" $retry || rc=$?
exit "$rc"
