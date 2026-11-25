#!/bin/sh
# One command that brings up the lab's model servers: it checks the machine, selects a measured tier that fits,
# writes model/.env, downloads the weights of the three models, starts the chat, embedding and reranker servers in
# that order, and proves them fit with the gate. It takes one of two toolchains from --host and the machine
# (uname -s, uname -m), and from nothing else: with --host, or on Linux, the servers run in Docker on a machine with
# one NVIDIA GPU, selected from model/tiers.json (steps 2 to 14 below); on an Apple silicon Mac without --host they
# run on the Mac with vLLM-Metal, from model/metal/tiers.json, and the rest of the sequence is model/metal/steps.sh.
# Any other machine is exit 3.
#
#   model/setup.sh --cache-dir <dir> [--bind <address>] [--port <n>] [--embed-port <n>] [--rerank-port <n>]
#                  [--host <docker-host>] [--tier <name>] [--check]
#   model/setup.sh --keep-env [--host <docker-host>] [--tier <name>] [--check]
#   On an Apple silicon Mac: --bind is refused, and the ports default to 8100, 8101 and 8102.
#
# Exit codes: 0 servers running and shown fit (with --check: the machine would get the printed tier),
#             1 a download failed or a server was not shown fit, 2 could not run,
#             3 this machine is not supported or is too small.
#
# This script only sequences commands and prints messages. Apart from the three checks of step 0,
# which must run before the tool can, every decision (flags, selection, disk verdict, the text of
# model/.env, health, capacity, exit codes) is made by model/setup/tool.ts, run in the pinned Node image on
# the local Docker daemon. The tool reports key=value lines ending in outcome= and exit_code=; a tool that
# exits non-zero did not run at all.
set -eu

NODE_IMAGE=node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
PROJECT=ai-on-aws-model
GATE_PROJECT=ai-on-aws-model-gate

say() {
  printf 'setup: %s\n' "$*" >&2
}

# ---------- 0. before the setup tool can run (each refusal here is exit 2: could not run) ----------

if [ -n "${DOCKER_HOST+set}" ]; then
  say "DOCKER_HOST is set in the environment. Unset it (unset DOCKER_HOST) and pass --host <docker-host> instead; setup never depends on it."
  exit 2
fi
refused=$(env | grep -E '^(MODEL|CHAT|EMBED|RERANK|COMPOSE)_[A-Za-z0-9_]*=' | cut -d= -f1 | sort -u | tr '\n' ' ' | sed 's/ $//')
if [ -n "$refused" ]; then
  say "these environment variables would override the settings files or change the compose file, project or profile: ${refused}. Unset them (unset NAME) and run setup again."
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  say "docker was not found on PATH."
  exit 2
fi
if ! docker version --format '{{.Server.Version}}' >/dev/null; then
  say "the local Docker daemon does not answer (docker version failed)."
  exit 2
fi

model_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

# ---------- the setup tool ----------

run_tool() {
  docker run --rm --network none \
    --mount "type=bind,source=$model_dir,target=/m,readonly" \
    -w /m/setup "$NODE_IMAGE" node tool.ts "$@"
}

# Same, with standard input passed to the tool.
run_tool_in() {
  docker run --rm -i --network none \
    --mount "type=bind,source=$model_dir,target=/m,readonly" \
    -w /m/setup "$NODE_IMAGE" node tool.ts "$@"
}

# The tool exits 0 whenever it ran; anything else means it could not be started or loaded, and there is no
# tool to map that to an exit code, so it is exit 2 here.
tool_broken() {
  say "the setup tool could not be run or did not load (exit status $1)."
  exit 2
}

toolchain='' toolchain_reason='' retrieval_env=''
memory_mib='' macos_version='' chat_repo='' chat_revision='' embed_repo='' embed_revision='' rerank_repo='' rerank_revision=''
env_state='' lock_sha256='' environment_need_mib=''
check='' keep_env='' cache_dir='' bind='' port='' embed_port='' rerank_port='' host='' tier='' gate_network=''
base_url='' embed_base_url='' rerank_base_url='' embed_model_id='' rerank_model_id=''
server_image='' selected_tier='' profile='' need_mib='' free_mib='' total_mib='' used_mib=''
gpu_name='' driver='' compute_cap='' model_id='' snapshot_path='' embed_snapshot_path='' rerank_snapshot_path=''
uid='' gid='' cache_free_mib='' docker_free_mib='' weights_state='' embed_weights_state='' rerank_weights_state='' weights_need_mib=''
image_state='' image_need_mib='' kv_cache_tokens='' context='' concurrency='' health=''
outcome='' exit_code=''

# Reads the tool's key=value lines into the variables above: one case arm per known key, nothing executed.
read_results() {
  outcome=''
  exit_code=''
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case $line in
      *=*) ;;
      *)
        say "unexpected output from the setup tool: $line"
        exit 2
        ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case $key in
      toolchain) toolchain=$value ;;
      toolchain_reason) toolchain_reason=$value ;;
      retrieval_env) retrieval_env=$value ;;
      memory_mib) memory_mib=$value ;;
      macos_version) macos_version=$value ;;
      chat_repo) chat_repo=$value ;;
      chat_revision) chat_revision=$value ;;
      embed_repo) embed_repo=$value ;;
      embed_revision) embed_revision=$value ;;
      rerank_repo) rerank_repo=$value ;;
      rerank_revision) rerank_revision=$value ;;
      env_state) env_state=$value ;;
      lock_sha256) lock_sha256=$value ;;
      environment_need_mib) environment_need_mib=$value ;;
      check) check=$value ;;
      keep_env) keep_env=$value ;;
      cache_dir) cache_dir=$value ;;
      bind) bind=$value ;;
      port) port=$value ;;
      embed_port) embed_port=$value ;;
      rerank_port) rerank_port=$value ;;
      host) host=$value ;;
      tier) tier=$value ;;
      base_url) base_url=$value ;;
      embed_base_url) embed_base_url=$value ;;
      rerank_base_url) rerank_base_url=$value ;;
      gate_network) gate_network=$value ;;
      server_image) server_image=$value ;;
      selected_tier) selected_tier=$value ;;
      profile) profile=$value ;;
      need_mib) need_mib=$value ;;
      free_mib) free_mib=$value ;;
      total_mib) total_mib=$value ;;
      used_mib) used_mib=$value ;;
      gpu_name) gpu_name=$value ;;
      driver) driver=$value ;;
      compute_cap) compute_cap=$value ;;
      model_id) model_id=$value ;;
      embed_model_id) embed_model_id=$value ;;
      rerank_model_id) rerank_model_id=$value ;;
      snapshot_path) snapshot_path=$value ;;
      embed_snapshot_path) embed_snapshot_path=$value ;;
      rerank_snapshot_path) rerank_snapshot_path=$value ;;
      uid) uid=$value ;;
      gid) gid=$value ;;
      cache_free_mib) cache_free_mib=$value ;;
      docker_free_mib) docker_free_mib=$value ;;
      weights_state) weights_state=$value ;;
      embed_weights_state) embed_weights_state=$value ;;
      rerank_weights_state) rerank_weights_state=$value ;;
      weights_need_mib) weights_need_mib=$value ;;
      image_state) image_state=$value ;;
      image_need_mib) image_need_mib=$value ;;
      kv_cache_tokens) kv_cache_tokens=$value ;;
      context) context=$value ;;
      concurrency) concurrency=$value ;;
      health) health=$value ;;
      outcome) outcome=$value ;;
      exit_code) exit_code=$value ;;
      *)
        say "unexpected output from the setup tool: $key"
        exit 2
        ;;
    esac
  done <<EOF
$1
EOF
}

# Takes a tool run (its exit status and output): stops with the tool's exit code unless the outcome is ok.
take() {
  [ "$1" -eq 0 ] || tool_broken "$1"
  read_results "$2"
  case $exit_code in
    0) ;;
    1 | 2 | 3) exit "$exit_code" ;;
    *) tool_broken "0, but no exit code reported" ;;
  esac
}

# Exit with the code of an outcome detected here; the tool holds the mapping.
exit_for() {
  rc=0
  out=$(run_tool exit-code "$1") || rc=$?
  take "$rc" "$out"
  tool_broken "0, but outcome $1 mapped to exit code 0"
}

stop_with() {
  say "$2"
  exit_for "$1"
}

# ---------- 1. arguments ----------

# The machine, for the toolchain. The tool decides; uname only reports.
rc=0
out=$(run_tool args "$(uname -s)" "$(uname -m)" -- "$@") || rc=$?
take "$rc" "$out"
say "toolchain: $toolchain ($toolchain_reason)"

# On an Apple silicon Mac the rest of the sequence is model/metal/steps.sh, which always ends by exiting.
if [ "$toolchain" = metal ]; then
  . "$model_dir/metal/steps.sh"
  tool_broken "0, but model/metal/steps.sh returned"
fi

# Docker commands for the GPU machine. DOCKER_HOST is given to these commands only, and only with --host.
gpu_docker() {
  if [ -n "$host" ]; then
    env DOCKER_HOST="$host" docker "$@"
  else
    docker "$@"
  fi
}
stop_prefix=''
if [ -n "$host" ]; then
  stop_prefix="DOCKER_HOST=$host "
fi

# ---------- 2. Docker on the GPU machine ----------

if [ -n "$host" ]; then
  if ! gpu_docker version --format '{{.Server.Version}}' >/dev/null; then
    stop_with docker_unreachable "the Docker daemon of the GPU machine ($host) does not answer."
  fi
fi

# ---------- 3. existing settings ----------

rc=0
out=$(run_tool settings nvidia "$check" "$keep_env" "$bind" "$port" "$cache_dir" "$embed_port" "$rerank_port") || rc=$?
take "$rc" "$out"

# ---------- 4. none of the lab's servers may be running ----------

if ! running=$(gpu_docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter status=running \
  --format '{{.Label "com.docker.compose.service"}}'); then
  stop_with docker_unreachable "could not list the containers on the GPU machine."
fi
rc=0
out=$(printf '%s\n' "$running" | run_tool_in running "$host") || rc=$?
take "$rc" "$out"

# ---------- 5. probe the GPU ----------

say "checking the GPU machine for an NVIDIA GPU available to containers"
if ! gpu_docker run --rm --network none "$NODE_IMAGE" true >/dev/null; then
  stop_with image_unavailable "the pinned Node image ($NODE_IMAGE) could not be run on the GPU machine's Docker daemon."
fi
probe_status=0
probe_out=$(gpu_docker run --rm --network none --gpus all "$NODE_IMAGE" \
  nvidia-smi --query-gpu=index,name,memory.total,memory.used,driver_version,compute_cap \
  --format=csv,noheader,nounits) || probe_status=$?

# ---------- 6. select a tier ----------

rc=0
out=$(printf '%s\n' "$probe_out" | run_tool_in select "$probe_status" "$tier") || rc=$?
take "$rc" "$out"

# ---------- 7. disk ----------

# The server image, read from the compose file. `config --images` needs every variable interpolated; the
# UID, GID and key are not known yet, so these three get values used for this one read-only call only.
images_status=0
images=$(env MODEL_BIND_ADDRESS="$bind" MODEL_PORT="$port" MODEL_EMBED_PORT="$embed_port" \
  MODEL_RERANK_PORT="$rerank_port" MODEL_CACHE_DIR="$cache_dir" \
  MODEL_RUN_UID=listing-images-only MODEL_RUN_GID=listing-images-only MODEL_API_KEY=listing-images-only \
  docker compose -f "$model_dir/compose.yaml" -p "$PROJECT" --env-file "$model_dir/profiles/$profile.env" \
  --env-file "$model_dir/retrieval.env" config --images) || images_status=$?
if [ "$images_status" -ne 0 ]; then
  stop_with repository_invalid "listing the server image with docker compose config --images failed (exit $images_status)."
fi
rc=0
out=$(printf '%s\n' "$images" | run_tool_in image) || rc=$?
take "$rc" "$out"

image_present=no
if gpu_docker image inspect "$server_image" >/dev/null 2>&1; then
  image_present=yes
fi

say "checking the cache directory and Docker's free space on the GPU machine"
disk_status=0
disk_out=$(gpu_docker run --rm --network none \
  --mount "type=bind,source=$cache_dir,target=/c,readonly" "$NODE_IMAGE" sh -c '
    set -e
    printf "owner %s\n" "$(stat -c "%u %g" /c)"
    printf "cache %s\n" "$(df -Pm /c | tail -n 1)"
    printf "docker %s\n" "$(df -Pm / | tail -n 1)"
    if [ -d "/c/$1" ]; then echo "weights present"; else echo "weights absent"; fi
    if [ -d "/c/$2" ]; then echo "embed-weights present"; else echo "embed-weights absent"; fi
    if [ -d "/c/$3" ]; then echo "rerank-weights present"; else echo "rerank-weights absent"; fi
  ' sh "$snapshot_path" "$embed_snapshot_path" "$rerank_snapshot_path") || disk_status=$?

rc=0
out=$(printf '%s\n' "$disk_out" | run_tool_in disk "$selected_tier" "$disk_status" "$image_present") || rc=$?
take "$rc" "$out"

# ---------- 8. --check stops here ----------

if [ "$check" = yes ]; then
  printf 'GPU:          %s (driver %s, compute capability %s)\n' "$gpu_name" "$driver" "$compute_cap"
  printf 'GPU memory:   %s MiB free of %s MiB (%s MiB in use)\n' "$free_mib" "$total_mib" "$used_mib"
  printf 'Tier:         %s (profile %s, model %s)\n' "$selected_tier" "$profile" "$model_id"
  printf 'Beside it:    embedding model %s, reranker %s\n' "$embed_model_id" "$rerank_model_id"
  printf 'Needs:        %s MiB of GPU memory for the three servers\n' "$need_mib"
  printf 'Weights:      in the cache: chat model %s, embedding model %s, reranker %s; need %s MiB, %s MiB free\n' \
    "$weights_state" "$embed_weights_state" "$rerank_weights_state" "$weights_need_mib" "$cache_free_mib"
  printf 'Server image: %s on the GPU machine; needs %s MiB, %s MiB free in Docker'"'"'s storage\n' "$image_state" "$image_need_mib" "$docker_free_mib"
  printf 'Disk:         enough\n'
  printf 'Check only: nothing was written, downloaded or started.\n'
  exit 0
fi

# ---------- 9. write model/.env ----------

if [ "$keep_env" != yes ]; then
  tmp_env="$model_dir/.env.tmp.$$"
  trap 'rm -f "$tmp_env"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if ! (umask 077 && set -C && : >"$tmp_env"); then
    stop_with env_write_failed "could not create $tmp_env."
  fi
  # render writes only the file's text to standard output, or nothing and a non-zero status.
  if ! run_tool render "$bind" "$port" "$embed_port" "$rerank_port" "$cache_dir" "$uid" "$gid" >"$tmp_env"; then
    rm -f "$tmp_env"
    stop_with env_write_failed "model/.env was not written."
  fi
  if ! mv -f "$tmp_env" "$model_dir/.env"; then
    stop_with env_write_failed "could not move $tmp_env to model/.env."
  fi
  say "wrote model/.env (mode 600)"
fi

# ---------- 10. download ----------

if ! rm -f "$model_dir/gate-report.json"; then
  stop_with report_remove_failed "could not remove model/gate-report.json left by an earlier run."
fi

compose_gpu() {
  gpu_docker compose -f "$model_dir/compose.yaml" -p "$PROJECT" \
    --env-file "$model_dir/.env" --env-file "$model_dir/profiles/$profile.env" --env-file "$model_dir/retrieval.env" "$@"
}

say "downloading the weights of the chat model (profile $profile), the embedding model and the reranker (each skipped by the downloader if already in the cache)"
for download in download download-embed download-rerank; do
  if ! compose_gpu --profile download run --rm "$download" >&2; then
    stop_with download_failed "downloading the weights failed ($download). model/.env stays."
  fi
done

# ---------- 11 to 13: a failure from here stops the servers and keeps their containers ----------

# The server being started or checked, and its container. During the gate, service is "all": a failure then
# shows the log of each of the three.
service='' cid=''

show_log() {
  say "last lines of the $service server's log (lines mentioning the API key are left out):"
  gpu_docker logs --tail 60 "$cid" 2>&1 | grep -v -i -e 'api-key' -e 'api_key' >&2 || :
}

stop_server() {
  if [ "$service" = all ]; then
    for service in chat embed rerank; do
      cid=$(compose_gpu ps -a -q "$service") || cid=''
      if [ -n "$cid" ]; then
        show_log
      fi
    done
  elif [ -n "$cid" ]; then
    show_log
  fi
  # The servers that depend on chat first. A service with no container is passed over.
  if compose_gpu stop rerank embed chat >&2; then
    say "the servers have been stopped; their containers are kept so their logs can be read: ${stop_prefix}docker compose -p $PROJECT logs chat embed rerank"
  else
    say "stopping the servers failed; stop them with: ${stop_prefix}docker compose -p $PROJECT stop"
  fi
  say "model/.env stays."
}

# A failure detected here: say why, stop the servers, exit with the outcome's code.
fail_server() {
  say "$2"
  stop_server
  exit_for "$1"
}

# Takes a tool run after a server has started: on any refusal, or a tool that did not run, stop the servers.
take_started() {
  if [ "$1" -ne 0 ]; then
    stop_server
    tool_broken "$1"
  fi
  read_results "$2"
  case $exit_code in
    0) ;;
    1 | 2 | 3)
      stop_server
      exit "$exit_code"
      ;;
    *)
      stop_server
      tool_broken "0, but no exit code reported"
      ;;
  esac
}

# Starts one server (chat, embed or rerank) and waits until its health check passes.
start_server() {
  service=$1
  cid=''
  say "starting the $service server"
  if ! compose_gpu up -d "$service" >&2; then
    fail_server not_healthy "starting the $service server failed."
  fi
  if ! cid=$(compose_gpu ps -a -q "$service") || [ -z "$cid" ]; then
    cid=''
    fail_server not_healthy "the $service server's container could not be found after starting it."
  fi

  say "waiting for the $service server to become healthy (up to 900 seconds)"
  waited=0
  while :; do
    inspect_status=0
    state=$(gpu_docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' "$cid") || inspect_status=$?
    rc=0
    out=$(run_tool health "$inspect_status" "$waited" "$state") || rc=$?
    take_started "$rc" "$out"
    if [ "$health" = ready ]; then
      break
    fi
    sleep 10
    waited=$((waited + 10))
  done
}

# The log of the server just started, for its start-up capacity line.
read_log() {
  logs_status=0
  logs=$(gpu_docker logs "$cid" 2>&1) || logs_status=$?
  if [ "$logs_status" -ne 0 ]; then
    fail_server log_unreadable "reading the $service server's log with docker logs failed (exit $logs_status)."
  fi
}

# ---------- 11. the chat server and its capacity ----------

start_server chat
read_log
rc=0
out=$(printf '%s\n' "$logs" | run_tool_in capacity nvidia "$profile") || rc=$?
take_started "$rc" "$out"
say "capacity: vLLM's cache holds $concurrency requests of $context tokens at once ($kv_cache_tokens tokens)"

# ---------- 12. the embedding server and its capacity, then the reranker ----------

start_server embed
read_log
rc=0
out=$(printf '%s\n' "$logs" | run_tool_in embed-capacity nvidia) || rc=$?
take_started "$rc" "$out"
say "capacity: the embedding server's cache holds $concurrency inputs of $context tokens at once ($kv_cache_tokens tokens)"

start_server rerank

# ---------- 13. gate ----------

say "running the gate on the three servers (this takes several minutes)"
service=all cid=''
rc=0
if [ "$gate_network" = host ]; then
  docker compose -f "$model_dir/gate/compose.yaml" -f "$model_dir/gate/compose.host-network.yaml" -p "$GATE_PROJECT" \
    --env-file "$model_dir/.env" --env-file "$model_dir/profiles/$profile.env" --env-file "$model_dir/retrieval.env" \
    run --rm -T gate >"$model_dir/gate-report.json" || rc=$?
else
  docker compose -f "$model_dir/gate/compose.yaml" -p "$GATE_PROJECT" \
    --env-file "$model_dir/.env" --env-file "$model_dir/profiles/$profile.env" --env-file "$model_dir/retrieval.env" \
    run --rm -T gate >"$model_dir/gate-report.json" || rc=$?
fi
if [ "$rc" -ne 0 ]; then
  fail_server gate_failed "the gate did not pass (exit $rc); its report is in model/gate-report.json."
fi

# ---------- 14. summary ----------

printf 'The model servers are running and passed the gate.\n'
printf '  Tier:         %s (profile %s)\n' "$selected_tier" "$profile"
printf '  Chat:         %s at %s\n' "$model_id" "$base_url"
printf '  Embedding:    %s at %s\n' "$embed_model_id" "$embed_base_url"
printf '  Reranker:     %s at %s\n' "$rerank_model_id" "$rerank_base_url"
printf '  API key:      in model/.env (MODEL_API_KEY), the same for all three\n'
printf '  Gate report:  model/gate-report.json\n'
printf '  Stop them:    %sdocker compose -p %s stop\n' "$stop_prefix" "$PROJECT"
printf '  Start again:  cd model && %sdocker compose -f compose.yaml -p %s --env-file .env --env-file profiles/%s.env --env-file retrieval.env up -d chat embed rerank\n' \
  "$stop_prefix" "$PROJECT" "$profile"
