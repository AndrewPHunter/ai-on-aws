#!/bin/sh
# Fetches the corpus into knowledge/data/ from the two tracked files in knowledge/corpus/ and nothing else.
#
# Downloads the benchmark files and every label version the manifest names. A file already present whose
# checksum matches is not downloaded again. A label whose XML checksum differs, whose version is no longer
# served, or whose download is refused as unsafe is not written: the run carries on, lists it on standard error
# and in knowledge/data/fetch-report.json, and exits 1. Takes no arguments; works from any directory. Needs a
# shell and Docker.
#
# Exit codes: 0 everything fetched and verified; 1 something was refused; 2 could not run.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

build_image
run_tool bridge ro fetch --corpus /corpus --data /data \
  --raw-base "$RAW_BASE" --dailymed-base "$DAILYMED_BASE" --user-agent "$USER_AGENT" \
  --dailymed-concurrency "$DAILYMED_CONCURRENCY" --github-concurrency "$GITHUB_CONCURRENCY" --workers "$WORKERS" \
  --attempts "$ATTEMPTS" --waits-ms "$WAITS_MS" --timeout-ms "$TIMEOUT_MS" \
  --zip-max-bytes "$ZIP_MAX_BYTES" --xml-max-bytes "$XML_MAX_BYTES" --benchmark-max-bytes "$BENCHMARK_MAX_BYTES"
