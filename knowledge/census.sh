#!/bin/sh
# Counts what the fetched labels are, in a container with no network, and writes knowledge/data/census.json
# and a summary on standard output. Counts and codes only, never label text. Takes no arguments; works from
# any directory. Needs a shell and Docker, and a fetch run first (knowledge/fetch.sh).
#
# Exit codes: 0 every pinned label counted; 1 some pinned labels are missing or do not match, and the census
#             covers the rest; 2 could not run.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

build_image
run_tool none ro census --corpus /corpus --data /data
