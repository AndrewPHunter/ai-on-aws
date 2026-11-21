#!/bin/sh
# Splits every parsed label into chunks that can be searched and cited, in a container with no network. Writes
# knowledge/data/chunks/<set id>/<version>.jsonl (one chunk per line, in document order) for each parsed label
# that passes the check that nothing was lost or doubled, and knowledge/data/chunk-report.json: numbers, codes and
# identifiers only. Takes no arguments; works from any directory. Needs a shell and Docker, and a parse run first
# (knowledge/parse.sh).
#
# Exit codes: 0 ran to the end, whatever the labels' results; 2 could not run.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

# Words of text a chunk may hold, and words above which a splittable table is split.
TEXT_LIMIT=300
TABLE_LIMIT=300

build_image
run_tool none ro chunk --corpus /corpus --data /data --text-limit "$TEXT_LIMIT" --table-limit "$TABLE_LIMIT"
