#!/bin/sh
# Asks the embedding server for a vector of every chunk of the last chunk run, from a container on a running stack's
# network, and writes knowledge/data/vectors/<set id>/<version>.jsonl (one line per chunk with a vector: its id and
# the vector as base64 of little-endian float32) and knowledge/data/embed-report.json (the model's identity, the
# document recipe and query instruction, the chunk report it came from, counts, chunk ids without a vector, and the
# vector files' sha256). knowledge/index.sh then loads the vectors with the chunks.
#
#   knowledge/embed.sh <compose-project>
#
# <compose-project> is the compose project the stack runs in: ai-on-aws for the lab. Needs a shell and Docker, a
# chunk run first (knowledge/chunk.sh), and model/.env from model/setup.sh, which gives the embedding server's
# address and the key. The model's identity comes from model/retrieval.env. Both are passed to the container by
# --env-file; this script reads neither.
#
# Exit codes: 0 every chunk has a vector, or is counted as without one because the server refused it as too long.
#             1 a request failed (after 2 more tries for 408, 429, 5xx or no answer), or a vector had the wrong length:
#               no report was written, and an old one was removed.
#             2 could not run: no chunk report, chunk files that do not match it, model/.env missing, or a server that
#               cannot be asked or does not list the model.
# It prints counts and chunk ids, never text, a vector or the key.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  say "usage: knowledge/embed.sh <compose-project>"
  exit 2
fi
network="$1_default"

# Passages in one request, requests in all for one batch or passage, the waits before the second and third, and the
# time one request may take.
BATCH_SIZE=32
ATTEMPTS=3
WAITS_MS=5000,30000
REQUEST_TIMEOUT_MS=120000

if [ ! -f "$repo_dir/model/.env" ]; then
  say "model/.env does not exist. Run model/setup.sh first."
  exit 2
fi

build_image
if ! docker network inspect --format '{{.Name}}' "$network" >/dev/null 2>&1; then
  say "there is no network $network: is the stack running in compose project $1?"
  exit 2
fi
run_tool_with_model_env "$network" ro embed --data /data --batch-size "$BATCH_SIZE" --attempts "$ATTEMPTS" \
  --waits-ms "$WAITS_MS" --timeout-ms "$REQUEST_TIMEOUT_MS"
