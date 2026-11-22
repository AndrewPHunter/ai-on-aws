#!/bin/sh
# Pins the corpus: run once, then commit knowledge/corpus/benchmark.json and knowledge/corpus/manifest.json.
#
# Downloads the FDARxBench labels and questions files at the revision below and records their checksums, then
# asks DailyMed for the history of every set id in the labels file, takes the highest version, downloads it,
# reads it safely and writes its manifest entry. A label DailyMed does not serve, or whose archive or XML is
# refused, is listed in the manifest as not pinned, with a reason code. Takes no arguments; works from any
# directory. Needs a shell and Docker.
#
# Exit codes: 0 both files written; 1 a request failed after every attempt, and neither file was written;
#             2 could not run.
set -eu

. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

BENCHMARK_REPOSITORY=https://github.com/xiongbetty/FDARxBench
BENCHMARK_REVISION=019785d2802c4ceec583e4d4b82b902d7a8f9910
BENCHMARK_LICENCE=Apache-2.0
BENCHMARK_LABELS_PATH=data/labels/labels.jsonl
BENCHMARK_QA_PATH=data/qa/qa.jsonl

build_image
run_tool bridge rw pin --corpus /corpus --data /data \
  --repository "$BENCHMARK_REPOSITORY" --revision "$BENCHMARK_REVISION" --licence "$BENCHMARK_LICENCE" \
  --labels-path "$BENCHMARK_LABELS_PATH" --qa-path "$BENCHMARK_QA_PATH" \
  --raw-base "$RAW_BASE" --dailymed-base "$DAILYMED_BASE" --user-agent "$USER_AGENT" \
  --dailymed-concurrency "$DAILYMED_CONCURRENCY" --github-concurrency "$GITHUB_CONCURRENCY" --workers "$WORKERS" \
  --attempts "$ATTEMPTS" --waits-ms "$WAITS_MS" --timeout-ms "$TIMEOUT_MS" \
  --zip-max-bytes "$ZIP_MAX_BYTES" --xml-max-bytes "$XML_MAX_BYTES" --benchmark-max-bytes "$BENCHMARK_MAX_BYTES"
