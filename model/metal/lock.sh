#!/bin/sh
# Writes model/metal/requirements.txt, the lock of the Metal model servers' Python environment, compiled by uv
# in a container from model/metal/requirements.in for Python 3.12 on aarch64-apple-darwin (macOS 15 or newer).
# Every package is pinned to one version with the sha256 of each of its files; the two packages the vllm-metal
# wheel takes from git commits are pinned by the full commit instead. Before the lock is put in place, the same
# container does a dry run of the install setup performs (--no-deps --verify-hashes) for that platform.
#
# requirements.in is passed twice: as the requirements and as overrides, so the PyTorch build it names replaces
# the torch, torchvision and torchaudio that vLLM core asks for. The container has the network (it reads PyPI,
# PyTorch's index, GitHub and the two git repositories). Takes no arguments; works from any directory. On any
# failure it exits non-zero and leaves the existing requirements.txt as it was.
set -eu

# ghcr.io/astral-sh/uv:0.13.10-python3.12-trixie (uv 0.13.10, with git), pinned by digest
UV_IMAGE=ghcr.io/astral-sh/uv@sha256:9f50f1b429323c90b42f680949330f6df669272329fdab5e682575476228cec9

metal_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

out_dir=$(mktemp -d)
staged="$metal_dir/.requirements.txt.$$"
cleanup() { rm -rf -- "$out_dir"; rm -f -- "$staged"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# uv prefers the versions an existing output file pins, so packages already locked do not move unless
# requirements.in asks for another version.
if [ -f "$metal_dir/requirements.txt" ]; then
  cp -- "$metal_dir/requirements.txt" "$out_dir/requirements.txt"
fi

docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$metal_dir,target=/in,readonly" \
  --mount "type=bind,source=$out_dir,target=/out" \
  -e HOME=/tmp -e UV_CACHE_DIR=/tmp/uv-cache -e MACOSX_DEPLOYMENT_TARGET=15.0 \
  -w /in "$UV_IMAGE" sh -eu -c '
    uv pip compile --no-config --quiet requirements.in --override requirements.in \
      --python-version 3.12 --python-platform aarch64-apple-darwin --generate-hashes \
      --custom-compile-command model/metal/lock.sh -o /out/requirements.txt
    echo "lock.sh: dry run of the install setup performs, for aarch64-apple-darwin" >&2
    uv pip install --no-config --dry-run --no-deps --verify-hashes -r /out/requirements.txt \
      --python-version 3.12 --python-platform aarch64-apple-darwin --target /tmp/dry-run
  '

if [ ! -s "$out_dir/requirements.txt" ]; then
  echo "lock.sh: the container produced no requirements.txt" >&2
  exit 1
fi

# Stage beside the target, then rename: the replacement is atomic on the same filesystem.
cp -- "$out_dir/requirements.txt" "$staged"
mv -f -- "$staged" "$metal_dir/requirements.txt"
echo "lock.sh: wrote model/metal/requirements.txt" >&2
