# Shared by the evaluation scripts; sourced, not run.
#
# Builds the evaluation piece's image from the `run` stage of toolchain/Dockerfile (the pinned Node image, the locked
# run-time dependencies, evaluation/src and shared/), named for this checkout. Each command then runs in a container
# with a read-only root filesystem, no capabilities and this user's ids. Mounted from the host: evaluation/ (read-only
# unless a command records the sample), evaluation/data/ (writable), and read-only the code and data it reads beside
# its own: knowledge/src (the shared reference rule), knowledge/corpus (the manifest), knowledge/data (the benchmark
# and the chunks) and agents/src (the expert's number rule).

evaluation_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
repo_dir=$(dirname -- "$evaluation_dir")
checkout=$(printf '%s' "$repo_dir" | cksum | cut -d ' ' -f 1)
EVALUATION_IMAGE="evaluation-harness:checkout-$checkout"

say() {
  printf '%s: %s\n' "$(basename -- "$0")" "$*" >&2
}

build_image() {
  if ! command -v docker >/dev/null 2>&1; then
    say "docker was not found on PATH."
    exit 2
  fi
  say "building image $EVALUATION_IMAGE from toolchain/Dockerfile (stage run)"
  if ! docker build --quiet --file "$repo_dir/toolchain/Dockerfile" --target run --build-arg PIECE=evaluation \
    --tag "$EVALUATION_IMAGE" "$repo_dir" >/dev/null; then
    say "the image could not be built."
    exit 2
  fi
}

# run_tool <evaluation mount: ro or rw> <tool arguments...>: no network.
run_tool() {
  evaluation_mode=$1
  shift
  evaluation_mount="type=bind,source=$evaluation_dir,target=/repo/evaluation"
  if [ "$evaluation_mode" = ro ]; then
    evaluation_mount="$evaluation_mount,readonly"
  fi
  mkdir -p -- "$evaluation_dir/data"
  docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
    --mount "$evaluation_mount" \
    --mount "type=bind,source=$evaluation_dir/data,target=/repo/evaluation/data" \
    --mount "type=bind,source=$repo_dir/knowledge/src,target=/repo/knowledge/src,readonly" \
    --mount "type=bind,source=$repo_dir/knowledge/corpus,target=/repo/knowledge/corpus,readonly" \
    --mount "type=bind,source=$repo_dir/knowledge/data,target=/repo/knowledge/data,readonly" \
    --mount "type=bind,source=$repo_dir/agents/src,target=/repo/agents/src,readonly" \
    -w /repo "$EVALUATION_IMAGE" node evaluation/src/main.ts "$@"
}

# A run's name: letters, digits, dot, dash and underscore, so it is always one folder under evaluation/data/runs/.
check_run_name() {
  case "$1" in
    '' | *[!A-Za-z0-9._-]* | .* )
      say "a run name is letters, digits, '.', '-' and '_', and does not start with '.': $1"
      exit 2
      ;;
  esac
}
