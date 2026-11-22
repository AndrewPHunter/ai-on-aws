#!/bin/sh
# Parses every fetched label into a structured document, in a container with no network. Writes
# knowledge/data/parsed/<set id>/<version>.json for each label without an error, and
# knowledge/data/parse-report.json with one entry for every label in the manifest: numbers, codes and identifiers
# only, never label text. Takes no arguments; works from any directory. Needs a shell and Docker, and a fetch
# run first (knowledge/fetch.sh).
#
# Exit codes: 0 ran to the end, whatever the labels' results; 2 could not run.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

build_image
run_tool none ro parse --corpus /corpus --data /data
