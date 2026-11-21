#!/bin/sh
# Loads the chunks under knowledge/data/chunks/ into the search engine of a running stack, from a container on that
# stack's network, and points the alias `labels` at the index only once the engine's count equals the chunks read.
# The index is named from the chunk report, which records the sha256 of every chunk file, and the mapping: a run on
# unchanged chunks changes nothing, and a change to any chunk's bytes makes a new index. knowledge/data is mounted
# read-only.
#
#   knowledge/index.sh <compose-project>
#
# <compose-project> is the compose project the stack runs in: ai-on-aws for the lab. Needs a shell and Docker, and
# a chunk run first (knowledge/chunk.sh).
#
# Exit codes: 0 the alias points at a complete index (built now, or already).
#             1 the engine refused items of a bulk request, or its count differed from the chunks read: the new
#               index was removed and the alias left as it was.
#             2 could not run: no chunk report, a report without chunk file hashes, a chunk file that does not match
#               its hash or holds a line that is not JSON (the file and line are named), or a search engine that
#               could not be asked or answered in a way that stops the run. Any index the run made was removed (or
#               named, if it could not be), and the alias left as it was.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  say "usage: knowledge/index.sh <compose-project>"
  exit 2
fi
network="$1_default"

SEARCH_URL=http://search:9200
ALIAS=labels
BATCH_SIZE=500
SEARCH_TIMEOUT_MS=60000

build_image
if ! docker network inspect --format '{{.Name}}' "$network" >/dev/null 2>&1; then
  say "there is no network $network: is the stack running in compose project $1?"
  exit 2
fi
run_tool "$network" read-only index --data /data --search-url "$SEARCH_URL" --alias "$ALIAS" \
  --batch-size "$BATCH_SIZE" --timeout-ms "$SEARCH_TIMEOUT_MS"
