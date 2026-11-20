#!/bin/sh
# Runs the setup tool's tests in the pinned Node image, with model/ mounted read-only and no network.
# Exits with the test runner's exit code.
set -eu

setup_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
model_dir=$(dirname -- "$setup_dir")

exec docker run --rm --network none \
  --mount "type=bind,source=$model_dir,target=/m,readonly" \
  -w /m/setup node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee \
  node --test "test/*.test.ts"
