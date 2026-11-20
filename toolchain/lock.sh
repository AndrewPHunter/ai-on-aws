#!/bin/sh
# Writes package-lock.json at the repository root, resolved by npm inside the pinned Node image from
# package.json and the existing lockfile (versions already locked do not move). Runs no install script.
# Takes no arguments; works from any directory. On any failure it exits non-zero and leaves the existing
# package-lock.json as it was.
set -eu

toolchain_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
repo_dir=$(dirname -- "$toolchain_dir")

out_dir=$(mktemp -d)
staged="$repo_dir/.package-lock.json.$$"
cleanup() { rm -rf -- "$out_dir"; rm -f -- "$staged"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# BuildKit's local output is written by the docker client, so the file belongs to the user running this.
docker build --file "$toolchain_dir/Dockerfile" --target lockfile \
  --output "type=local,dest=$out_dir" "$repo_dir"

if [ ! -s "$out_dir/package-lock.json" ]; then
  echo "lock.sh: the build produced no package-lock.json" >&2
  exit 1
fi

# Stage beside the target, then rename: the replacement is atomic on the same filesystem.
cp -- "$out_dir/package-lock.json" "$staged"
mv -f -- "$staged" "$repo_dir/package-lock.json"
