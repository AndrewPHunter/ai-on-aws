# The Metal sequence of model/setup.sh: sourced by it once the tool has chosen the metal toolchain (an Apple silicon
# Mac, no --host), after the shell guard and the flags. It uses setup.sh's helpers (say, run_tool, run_tool_in,
# take, stop_with, exit_for, tool_broken) and the values the flags gave, and always ends by exiting.
#
# Everything runs on this Mac. The servers are vLLM-Metal processes of the user running setup, started and stopped
# by model/metal/servers.sh; everything setup puts on the Mac is in the cache directory: the Python environment
# (<cache>/vllm-metal/venv, with uv's cache and the Python it installs beside it), the weights (<cache>/hf), and the
# servers' logs and pid files (<cache>/vllm-metal/run). As in setup.sh, every decision is the tool's; this file
# sequences commands and prints.
#
# Steps: M1 host tools; M2 none of the lab's servers running; M3 existing settings; M4 the three ports free; M5 the
# machine check and the tier; M6 disk; --check stops there; M7 write model/.env; M8 the environment; M9 downloads;
# M10 to M12 the servers and their capacity; M13 the gate; M14 the summary.

servers_sh="$model_dir/metal/servers.sh"
metal_retrieval="$model_dir/metal/retrieval.env"

# ---------- M1. host tools (none is installed by setup) ----------

for host_tool in uv git curl; do
  if ! command -v "$host_tool" >/dev/null 2>&1; then
    stop_with host_tool_missing "$host_tool was not found on PATH. Setup on an Apple silicon Mac needs uv (it builds the servers' Python environment), git (two packages of that environment come from git commits) and curl (the port check and each server's /health); install it and run setup again."
  fi
done

# ---------- M2. none of the lab's servers may be running ----------

# Found by process, under any cache directory, so that a server whose model/.env is gone is found too: every
# process of this user and others, with its command line, for the tool to look for <dir>/vllm-metal/venv/bin/vllm.
if ! processes=$(ps -A -ww -o pid= -o command=); then
  stop_with server_running "listing this Mac's processes with ps failed, so whether the lab's servers are running is not known."
fi
rc=0
out=$(printf '%s\n' "$processes" | run_tool_in metal-running) || rc=$?
take "$rc" "$out"

# ---------- M3. existing settings ----------

rc=0
out=$(run_tool settings metal "$check" "$keep_env" "$bind" "$port" "$cache_dir" "$embed_port" "$rerank_port") || rc=$?
take "$rc" "$out"

venv_dir="$cache_dir/vllm-metal/venv"
run_dir="$cache_dir/vllm-metal/run"
stamp_file="$venv_dir/.lock-sha256"

# ---------- M4. the three ports ----------

# A port is free only when a connection to it on 127.0.0.1 is refused (curl exits 7); anything else, a timeout
# included, counts as taken. A connection sees a listener of any user. -q first: no ~/.curlrc; no proxy.
taken=''
for listen_port in "$port" "$embed_port" "$rerank_port"; do
  connect=0
  curl -q --noproxy '*' --silent --output /dev/null --max-time 2 "http://127.0.0.1:$listen_port/" || connect=$?
  if [ "$connect" -ne 7 ]; then
    taken="$taken$listen_port
"
  fi
done
rc=0
out=$(printf '%s' "$taken" | run_tool_in ports) || rc=$?
take "$rc" "$out"

# ---------- M5. the machine check and the tier ----------

say "checking this Mac's macOS version and memory"
macos_reported=$(sw_vers -productVersion 2>/dev/null || :)
memory_reported=$(sysctl -n hw.memsize 2>/dev/null || :)
rc=0
out=$(run_tool metal-select "$tier" "$macos_reported" "$memory_reported") || rc=$?
take "$rc" "$out"

if pmset -g batt 2>/dev/null | grep -q "'Battery Power'"; then
  say "this Mac is on battery power: setup continues, and the gate, which measures speed, may run slower than on AC power"
fi

# ---------- M6. disk ----------

say "checking the cache directory and the free space on its volume"
if [ ! -d "$cache_dir" ]; then
  cache_state=missing
elif [ ! -w "$cache_dir" ]; then
  cache_state=unwritable
else
  cache_state=ok
fi
disk_out=''
if [ "$cache_state" = ok ]; then
  presence() {
    if [ -d "$cache_dir/$1" ]; then echo present; else echo absent; fi
  }
  stamp=none
  if [ -f "$stamp_file" ]; then
    # One line, whatever the file holds; the tool takes anything but one sha256 as "not installed from this lock".
    stamp=$(tr -s '\r\n\t' '   ' <"$stamp_file") || stamp=''
  fi
  # df -m: 1 MiB blocks; -I: no inode columns, so the line has the shape of a POSIX df line.
  disk_out=$(
    printf 'cache %s\n' "$(df -m -I "$cache_dir" | tail -n 1)"
    printf 'weights %s\n' "$(presence "$snapshot_path")"
    printf 'embed-weights %s\n' "$(presence "$embed_snapshot_path")"
    printf 'rerank-weights %s\n' "$(presence "$rerank_snapshot_path")"
    printf 'stamp %s\n' "$stamp"
  )
fi
rc=0
out=$(printf '%s\n' "$disk_out" | run_tool_in metal-disk "$selected_tier" "$cache_state") || rc=$?
take "$rc" "$out"

# ---------- --check stops here ----------

if [ "$check" = yes ]; then
  printf 'Machine:      Apple silicon Mac, macOS %s, %s MiB of memory\n' "$macos_version" "$memory_mib"
  printf 'Tier:         %s (profile %s, model %s)\n' "$selected_tier" "$profile" "$model_id"
  printf 'Beside it:    embedding model %s, reranker %s\n' "$embed_model_id" "$rerank_model_id"
  printf 'Needs:        %s MiB of memory for the three servers\n' "$need_mib"
  printf 'Environment:  %s; needs %s MiB\n' "$( [ "$env_state" = present ] && echo 'installed from this lock' || echo 'not installed from this lock')" "$environment_need_mib"
  printf 'Weights:      in the cache: chat model %s, embedding model %s, reranker %s; need %s MiB\n' \
    "$weights_state" "$embed_weights_state" "$rerank_weights_state" "$weights_need_mib"
  printf 'Disk:         %s MiB free in the cache directory; enough\n' "$cache_free_mib"
  printf 'Check only: nothing was written, downloaded or started.\n'
  exit 0
fi

# ---------- M7. write model/.env ----------

if [ "$keep_env" != yes ]; then
  tmp_env="$model_dir/.env.tmp.$$"
  trap 'rm -f "$tmp_env"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if ! (umask 077 && set -C && : >"$tmp_env"); then
    stop_with env_write_failed "could not create $tmp_env."
  fi
  # render-metal writes only the file's text to standard output, or nothing and a non-zero status.
  if ! run_tool render-metal "$port" "$embed_port" "$rerank_port" "$cache_dir" "$(id -u)" "$(id -g)" >"$tmp_env"; then
    rm -f "$tmp_env"
    stop_with env_write_failed "model/.env was not written."
  fi
  if ! mv -f "$tmp_env" "$model_dir/.env"; then
    stop_with env_write_failed "could not move $tmp_env to model/.env."
  fi
  say "wrote model/.env (mode 600)"
fi

# ---------- M8. the Python environment, from the lock only ----------

# uv runs with only these settings: no configuration file of the user's (--no-config), its cache and the Python it
# installs under the cache directory, and the shell's PATH, by which it finds git.
uv_env() {
  env -i PATH="$PATH" HOME="$cache_dir/vllm-metal/home" \
    UV_CACHE_DIR="$cache_dir/vllm-metal/uv-cache" UV_PYTHON_INSTALL_DIR="$cache_dir/vllm-metal/python" \
    uv "$@"
}

if [ "$env_state" = present ]; then
  say "the servers' Python environment is installed from this lock ($venv_dir); it is left as it is"
else
  say "installing the servers' Python environment from model/metal/requirements.txt into $venv_dir (about 2 GB)"
  if ! rm -rf -- "$venv_dir"; then
    stop_with environment_failed "could not remove the earlier environment $venv_dir. model/.env stays."
  fi
  if ! mkdir -p -- "$cache_dir/vllm-metal/home"; then
    stop_with environment_failed "could not create $cache_dir/vllm-metal. model/.env stays."
  fi
  if ! uv_env venv --no-config --python 3.12.15 "$venv_dir" >&2; then
    stop_with environment_failed "uv could not make a Python 3.12.15 environment in $venv_dir. model/.env stays."
  fi
  if ! uv_env pip install --no-config --python "$venv_dir/bin/python" --no-deps --verify-hashes \
    -r "$model_dir/metal/requirements.txt" >&2; then
    stop_with environment_failed "installing model/metal/requirements.txt into $venv_dir failed; the environment is not stamped and is installed again next time. model/.env stays."
  fi
  if ! printf '%s\n' "$lock_sha256" >"$stamp_file"; then
    stop_with environment_failed "could not write $stamp_file. model/.env stays."
  fi
fi

# ---------- M9. download ----------

if ! rm -f "$model_dir/gate-report.json"; then
  stop_with report_remove_failed "could not remove model/gate-report.json left by an earlier run."
fi

# The Hugging Face client runs with only these settings: the cache directory, telemetry off and no token.
hf_download() {
  env -i PATH="$venv_dir/bin:/usr/bin:/bin" HOME="$cache_dir/vllm-metal/home" HF_HOME="$cache_dir/hf" \
    HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 \
    "$venv_dir/bin/hf" download "$1" --revision "$2" >&2
}

say "downloading the weights of the chat model (profile $profile), the embedding model and the reranker (each skipped by the downloader if already in the cache)"
if ! hf_download "$chat_repo" "$chat_revision"; then
  stop_with download_failed "downloading the weights failed ($chat_repo). model/.env stays."
fi
if ! hf_download "$embed_repo" "$embed_revision"; then
  stop_with download_failed "downloading the weights failed ($embed_repo). model/.env stays."
fi
if ! hf_download "$rerank_repo" "$rerank_revision"; then
  stop_with download_failed "downloading the weights failed ($rerank_repo). model/.env stays."
fi

# ---------- M10 to M13: a failure from here stops the servers and keeps their logs ----------

# The server being started or checked. During the gate it is "all": a failure then shows each of the three logs.
server=''

metal_show_log() {
  say "last lines of the $1 server's log (lines mentioning the API key are left out):"
  tail -n 60 "$run_dir/$1.log" 2>&1 | grep -v -i -e 'api-key' -e 'api_key' >&2 || :
}

metal_stop_servers() {
  if [ "$server" = all ]; then
    for logged in chat embed rerank; do
      if [ -f "$run_dir/$logged.log" ]; then
        metal_show_log "$logged"
      fi
    done
  elif [ -n "$server" ] && [ -f "$run_dir/$server.log" ]; then
    metal_show_log "$server"
  fi
  if sh "$servers_sh" stop; then
    say "the servers have been stopped; their logs stay in $run_dir"
  else
    say "stopping the servers failed; stop them with: model/metal/servers.sh stop"
  fi
  say "model/.env stays."
}

metal_fail_server() {
  say "$2"
  metal_stop_servers
  exit_for "$1"
}

# Takes a tool run after a server has started: on any refusal, or a tool that did not run, stop the servers.
metal_take_started() {
  if [ "$1" -ne 0 ]; then
    metal_stop_servers
    tool_broken "$1"
  fi
  read_results "$2"
  case $exit_code in
    0) ;;
    1 | 2 | 3)
      metal_stop_servers
      exit "$exit_code"
      ;;
    *)
      metal_stop_servers
      tool_broken "0, but no exit code reported"
      ;;
  esac
}

# Starts one server (chat, embed or rerank) on its port and waits until its /health answers.
metal_start_server() {
  server=$1
  server_port=$2
  say "starting the $server server"
  if ! sh "$servers_sh" start "$profile" "$server"; then
    metal_fail_server not_healthy "starting the $server server failed."
  fi
  say "waiting for the $server server to answer /health (up to 900 seconds)"
  waited=0
  while :; do
    alive=no
    if sh "$servers_sh" status | grep -q "^$server running"; then
      alive=yes
    fi
    healthy=no
    if curl -q --noproxy '*' --fail --silent --output /dev/null --max-time 5 "http://127.0.0.1:$server_port/health"; then
      healthy=yes
    fi
    rc=0
    out=$(run_tool metal-health "$alive" "$healthy" "$waited") || rc=$?
    metal_take_started "$rc" "$out"
    if [ "$health" = ready ]; then
      break
    fi
    sleep 10
    waited=$((waited + 10))
  done
}

# The log of the server just started, for its start-up capacity line.
metal_read_log() {
  if ! logs=$(cat "$run_dir/$server.log"); then
    metal_fail_server log_unreadable "reading the $server server's log ($run_dir/$server.log) failed."
  fi
}

# ---------- M10. the chat server and its capacity ----------

metal_start_server chat "$port"
metal_read_log
rc=0
out=$(printf '%s\n' "$logs" | run_tool_in capacity metal "$profile") || rc=$?
metal_take_started "$rc" "$out"
say "capacity: vLLM's cache holds $concurrency requests of $context tokens at once ($kv_cache_tokens tokens)"

# ---------- M11. the embedding server and its capacity ----------

metal_start_server embed "$embed_port"
metal_read_log
rc=0
out=$(printf '%s\n' "$logs" | run_tool_in embed-capacity metal) || rc=$?
metal_take_started "$rc" "$out"
say "capacity: the embedding server's cache holds $concurrency inputs of $context tokens at once ($kv_cache_tokens tokens)"

# ---------- M12. the reranker ----------

metal_start_server rerank "$rerank_port"

# ---------- M13. gate ----------

say "running the gate on the three servers (this takes several minutes)"
server=all
rc=0
docker compose -f "$model_dir/gate/compose.yaml" -p "$GATE_PROJECT" \
  --env-file "$model_dir/.env" --env-file "$model_dir/profiles/$profile.env" --env-file "$metal_retrieval" \
  run --rm -T gate >"$model_dir/gate-report.json" || rc=$?
if [ "$rc" -ne 0 ]; then
  metal_fail_server gate_failed "the gate did not pass (exit $rc); its report is in model/gate-report.json."
fi

# ---------- M14. summary ----------

printf 'The model servers are running on this Mac and passed the gate.\n'
printf '  Tier:         %s (profile %s)\n' "$selected_tier" "$profile"
printf '  Chat:         %s at %s\n' "$model_id" "$base_url"
printf '  Embedding:    %s at %s\n' "$embed_model_id" "$embed_base_url"
printf '  Reranker:     %s at %s\n' "$rerank_model_id" "$rerank_base_url"
printf '  API key:      in model/.env (MODEL_API_KEY), the same for all three\n'
printf '  Gate report:  model/gate-report.json\n'
printf '  Logs:         %s\n' "$run_dir"
printf '  Stop them:    model/metal/servers.sh stop\n'
printf '  Start again:  model/metal/servers.sh start %s\n' "$profile"
exit 0
