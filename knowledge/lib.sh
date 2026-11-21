# Shared by knowledge/pin.sh, fetch.sh and census.sh; sourced, not run.
#
# Builds the knowledge piece's image from the `run` stage of toolchain/Dockerfile, which starts from the Node
# image pinned there by digest and adds the locked run-time dependencies and knowledge/src. The image is named
# for this checkout, so two checkouts never run each other's image. The tool then runs in a container with a
# read-only root filesystem, no capabilities, and this user's ids, with only knowledge/corpus and knowledge/data
# mounted from the host.

knowledge_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
repo_dir=$(dirname -- "$knowledge_dir")
checkout=$(printf '%s' "$repo_dir" | cksum | cut -d ' ' -f 1)
KNOWLEDGE_IMAGE="knowledge-corpus:checkout-$checkout"

# Every setting the tool takes is passed by name here. None comes from the environment.
DAILYMED_BASE=https://dailymed.nlm.nih.gov/dailymed
RAW_BASE=https://raw.githubusercontent.com
USER_AGENT=label-corpus-fetch/1.0
DAILYMED_CONCURRENCY=2
GITHUB_CONCURRENCY=1
WORKERS=2
ATTEMPTS=3
WAITS_MS=10000,60000
TIMEOUT_MS=120000
ZIP_MAX_BYTES=52428800
XML_MAX_BYTES=20971520
BENCHMARK_MAX_BYTES=268435456

say() {
  printf '%s: %s\n' "$(basename -- "$0")" "$*" >&2
}

build_image() {
  if ! command -v docker >/dev/null 2>&1; then
    say "docker was not found on PATH."
    exit 2
  fi
  say "building image $KNOWLEDGE_IMAGE from toolchain/Dockerfile (stage run)"
  if ! docker build --quiet --file "$repo_dir/toolchain/Dockerfile" --target run --build-arg PIECE=knowledge \
    --tag "$KNOWLEDGE_IMAGE" "$repo_dir" >/dev/null; then
    say "the image could not be built."
    exit 2
  fi
}

# run_tool <network> <mounts> <tool arguments...>
#   <mounts>: rw         knowledge/corpus and knowledge/data writable
#             ro         knowledge/corpus read-only, knowledge/data writable
#             read-only  both read-only (a tool that only reads, such as the index command)
run_tool() {
  network=$1
  mounts=$2
  shift 2
  corpus_mount="type=bind,source=$knowledge_dir/corpus,target=/corpus"
  data_mount="type=bind,source=$knowledge_dir/data,target=/data"
  case "$mounts" in
    rw) ;;
    ro) corpus_mount="$corpus_mount,readonly" ;;
    read-only)
      corpus_mount="$corpus_mount,readonly"
      data_mount="$data_mount,readonly"
      ;;
    *)
      say "run_tool: unknown mounts $mounts"
      exit 2
      ;;
  esac
  mkdir -p -- "$knowledge_dir/corpus" "$knowledge_dir/data"
  docker run --rm --network "$network" --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
    --mount "$corpus_mount" --mount "$data_mount" \
    -w /repo "$KNOWLEDGE_IMAGE" node knowledge/src/main.ts "$@"
}
