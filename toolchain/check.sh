#!/bin/sh
# Typechecks, lints and tests every TypeScript file in the repository, in a container with no network
# and a read-only root filesystem. Takes no arguments; works from any directory.
# Exits 0 only if the image builds and all three checks pass.
set -eu

toolchain_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
repo_dir=$(dirname -- "$toolchain_dir")
compose_file="$toolchain_dir/compose.yaml"

# Each checkout of the repository gets its own image and its own compose project, named from the
# checkout's path. Two checkouts, for example two git worktrees, can then be checked at the same time
# without one running the image the other has just built.
checkout=$(printf '%s' "$repo_dir" | cksum | cut -d ' ' -f 1)
CHECK_IMAGE_TAG="checkout-$checkout"
export CHECK_IMAGE_TAG
project="ai-on-aws-toolchain-$checkout"
echo "check.sh: image ai-on-aws-toolchain-check:$CHECK_IMAGE_TAG" >&2

docker compose -p "$project" -f "$compose_file" build check
exec docker compose -p "$project" -f "$compose_file" run --rm check
