#!/bin/sh
# Typechecks, lints and tests every TypeScript file in the repository, in a container with no network
# and a read-only root filesystem. Takes no arguments; works from any directory.
# Exits 0 only if the image builds and all three checks pass.
set -eu

toolchain_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
compose_file="$toolchain_dir/compose.yaml"

docker compose -f "$compose_file" build check
exec docker compose -f "$compose_file" run --rm check
