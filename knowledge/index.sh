#!/bin/sh
# Loads the chunks under knowledge/data/chunks/ into the search engine of a running stack, from a container on that
# stack's network, and points the alias `labels` at the index only once the engine's count equals the chunks read.
# The index is named from the chunk report, which records the sha256 of every chunk file, the embed report when there
# is one (which records the sha256 of the vector files), and the mapping: a run on unchanged chunks and vectors
# changes nothing, and a change to any chunk's or vector's bytes makes a new index. With an embed report
# (knowledge/embed.sh) every document is loaded with its vector, if it has one; without, the index has no vectors.
# knowledge/data is mounted read-only.
#
#   knowledge/index.sh <compose-project>
#
# <compose-project> is the compose project the stack runs in: ai-on-aws for the lab. Needs a shell and Docker, and
# a chunk run first (knowledge/chunk.sh).
#
# Exit codes: 0 the alias points at a complete index (built now, or already).
#             1 the embed report was made from other chunks: nothing was built. Or the engine refused items of a bulk
#               request, its count differed from the chunks read, or its count of documents with a vector differed
#               from the embed report's: the new index was removed. The alias was left as it was.
#             2 could not run: no chunk report, a report without chunk file hashes, a chunk file that does not match
#               its hash or holds a line that is not JSON (the file and line are named), vector files that do not
#               match the embed report's hash or hold a vector of the wrong length, or a search engine that
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
# The most bytes of body in one bulk request (8 MiB): about 380 documents with their vectors, measured at about
# 21.7 KB each.
BATCH_BYTES=8388608
SEARCH_TIMEOUT_MS=60000

build_image
if ! docker network inspect --format '{{.Name}}' "$network" >/dev/null 2>&1; then
  say "there is no network $network: is the stack running in compose project $1?"
  exit 2
fi
run_tool "$network" read-only index --data /data --search-url "$SEARCH_URL" --alias "$ALIAS" \
  --batch-bytes "$BATCH_BYTES" --timeout-ms "$SEARCH_TIMEOUT_MS"
