#!/bin/sh
# Starts, stops and reports the lab's three model servers on an Apple silicon Mac: vLLM-Metal processes of the user
# running this, from the Python environment model/setup.sh installs. The one place they are started and stopped,
# used by setup (model/metal/steps.sh) and by the operator.
#
#   model/metal/servers.sh start <profile> [chat|embed|rerank ...]   default: all three
#   model/metal/servers.sh stop [chat|embed|rerank ...]              default: all three
#   model/metal/servers.sh status
#
# It reads model/.env (the key, the ports, the cache directory and the retrieval settings file), the profile
# model/profiles/<profile>.env and the retrieval settings, each as text: no file is sourced. Each server is started
# detached, as the leader of its own process group, with exactly this environment: VLLM_API_KEY (the key),
# PATH=<cache>/vllm-metal/venv/bin:/usr/bin:/bin:/usr/sbin:/sbin, HOME=<cache>/vllm-metal/home, HF_HOME=<cache>/hf,
# HF_HUB_OFFLINE=1, HF_HUB_DISABLE_TELEMETRY=1, HF_HUB_DISABLE_IMPLICIT_TOKEN=1, VLLM_NO_USAGE_STATS=1, DO_NOT_TRACK=1,
# and VLLM_ENABLE_V1_MULTIPROCESSING=0 for the embedding and reranker servers only. The key goes from model/.env into
# the server's environment without being on any command line, and is never printed.
#
# Each server's log is <cache>/vllm-metal/run/<server>.log, written again at each start, with its pid file beside
# it. The pid file holds the id of the server's first process, which is also its process group's id, and that
# process's start time. A server is running while its group has a member, even after its first process has ended;
# a process with the recorded id that started at another time is another program's, and is neither counted nor
# signalled. Starting a server that is running is refused. Starting chat with the others starts them once chat's
# /health answers, waiting up to 900 seconds. Stopping ends each server's process group and waits until it has no
# member.
#
# Exit codes: 0 done; 1 chat did not answer /health while starting the others, or a server's processes survived
# SIGKILL (the others are still stopped); 2 could not run.
set -eu

say() {
  printf 'servers: %s\n' "$*" >&2
}

die() {
  say "$*"
  exit 2
}

metal_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
model_dir=$(dirname -- "$metal_dir")
env_file="$model_dir/.env"

# The value of NAME in an env file, taken as written: exactly one NAME=value line, or the script stops.
setting() {
  file=$1 name=$2
  count=$(grep -c "^$name=" "$file" || :)
  [ "$count" = 1 ] || die "${file#"$model_dir"/} must define $name exactly once."
  sed -n "s/^$name=//p" "$file"
}

[ -f "$env_file" ] || die "model/.env does not exist: set the servers up with model/setup.sh first."
[ "$(setting "$env_file" MODEL_TOOLCHAIN)" = metal ] || die "model/.env is not an Apple silicon Mac's (MODEL_TOOLCHAIN is not metal)."
[ "$(setting "$env_file" MODEL_RETRIEVAL_ENV)" = metal/retrieval.env ] || die "model/.env: MODEL_RETRIEVAL_ENV is not metal/retrieval.env."
retrieval_file="$model_dir/metal/retrieval.env"
cache_dir=$(setting "$env_file" MODEL_CACHE_DIR)
case $cache_dir in
  /*) ;;
  *) die "model/.env: MODEL_CACHE_DIR is not an absolute path." ;;
esac
# Read here only to stop when it is missing or empty; the server reads it itself (see launch).
[ -n "$(setting "$env_file" MODEL_API_KEY)" ] || die "model/.env: MODEL_API_KEY is empty."

venv_dir="$cache_dir/vllm-metal/venv"
run_dir="$cache_dir/vllm-metal/run"
home_dir="$cache_dir/vllm-metal/home"

port_of() {
  case $1 in
    chat) value=$(setting "$env_file" MODEL_PORT) ;;
    embed) value=$(setting "$env_file" MODEL_EMBED_PORT) ;;
    rerank) value=$(setting "$env_file" MODEL_RERANK_PORT) ;;
  esac
  case $value in
    '' | *[!0-9]*) die "model/.env: the $1 server's port is not a number: $value" ;;
  esac
  printf '%s\n' "$value"
}

# When a process started, as ps prints it with its white space collapsed, or nothing when there is no such process.
# In UTC and the C locale, so that neither the Mac's time zone nor its language changes it.
start_time() {
  TZ=UTC LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null | tr -s ' \t' '  ' | sed 's/^ //; s/ $//' || :
}

# True while the process group has a member.
group_alive() {
  kill -0 -- "-$1" 2>/dev/null
}

# The server's process group id (its first process's id) while it is running, or nothing. A server whose first
# process has ended while others of its group are alive is still running. A process with the recorded id that
# started at another time is another program's: the server is then not running, and that process is never signalled.
running_pid() {
  pid_file="$run_dir/$1.pid"
  [ -f "$pid_file" ] || return 0
  read -r pid started <"$pid_file" || return 0
  case $pid in
    '' | *[!0-9]*) return 0 ;;
  esac
  now=$(start_time "$pid")
  if [ -n "$now" ]; then
    [ "$now" != "$started" ] || printf '%s\n' "$pid"
  elif group_alive "$pid"; then
    printf '%s\n' "$pid"
  fi
}

# The program that becomes each server, run by the environment's Python in isolated mode (-I: no PYTHON* variable,
# no user site). It makes the process the leader of a new session and process group, so the server outlives this
# script and the terminal and is stopped as a group; reads the key from model/.env (named by SERVERS_SETTINGS_FILE);
# and replaces itself with vLLM, whose environment is exactly the names below that are set, plus VLLM_API_KEY. The key
# is on no command line.
LAUNCHER='
import os, sys
try:
    os.setsid()
except OSError:
    pass
key = ""
with open(os.environ["SERVERS_SETTINGS_FILE"], encoding="utf-8") as settings:
    for line in settings:
        if line.startswith("MODEL_API_KEY="):
            key = line[len("MODEL_API_KEY="):].rstrip("\r\n")
if key == "":
    sys.exit("servers: model/.env has no MODEL_API_KEY")
names = ("PATH", "HOME", "HF_HOME", "HF_HUB_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN",
         "VLLM_NO_USAGE_STATS", "DO_NOT_TRACK", "VLLM_ENABLE_V1_MULTIPROCESSING")
env = {name: os.environ[name] for name in names if name in os.environ}
env["VLLM_API_KEY"] = key
os.execve(sys.argv[1], sys.argv[1:], env)
'

# Starts one vLLM server detached: `launch <server> <log> [VLLM_ENABLE_V1_MULTIPROCESSING=0] -- <vllm serve args>`.
launch() {
  name=$1 log=$2
  shift 2
  extra=''
  if [ "$1" != -- ]; then
    extra=$1
    shift
  fi
  shift
  mkdir -p "$run_dir" "$home_dir"
  (
    cd "$run_dir"
    exec /usr/bin/env -i \
      PATH="$venv_dir/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      HOME="$home_dir" \
      HF_HOME="$cache_dir/hf" \
      HF_HUB_OFFLINE=1 \
      HF_HUB_DISABLE_TELEMETRY=1 \
      HF_HUB_DISABLE_IMPLICIT_TOKEN=1 \
      VLLM_NO_USAGE_STATS=1 \
      DO_NOT_TRACK=1 \
      ${extra:+"$extra"} \
      SERVERS_SETTINGS_FILE="$env_file" \
      "$venv_dir/bin/python" -I -c "$LAUNCHER" "$venv_dir/bin/vllm" serve "$@"
  ) </dev/null >"$log" 2>&1 &
  pid=$!
  started=$(start_time "$pid")
  [ -n "$started" ] || die "the $name server ended at once; its log: $log"
  printf '%s %s\n' "$pid" "$started" >"$run_dir/$name.pid"
  say "started the $name server (process group $pid); its log: $log"
}

start_one() {
  name=$1
  pid=$(running_pid "$name")
  [ -z "$pid" ] || die "the $name server is already running (pid $pid): stop it first with model/metal/servers.sh stop $name"
  [ -x "$venv_dir/bin/vllm" ] || die "the servers' environment is not installed ($venv_dir): set the servers up with model/setup.sh first."
  port=$(port_of "$name")
  log="$run_dir/$name.log"
  # Each setting is read by an assignment of its own, so that one missing stops the script (set -e) instead of
  # reaching vLLM as an empty argument.
  case $name in
    chat)
      repo=$(setting "$profile_file" CHAT_MODEL_REPO)
      revision=$(setting "$profile_file" CHAT_MODEL_REVISION)
      served=$(setting "$profile_file" MODEL_ID)
      max_len=$(setting "$profile_file" CHAT_MAX_MODEL_LEN)
      max_seqs=$(setting "$profile_file" CHAT_MAX_NUM_SEQS)
      cache_bytes=$(setting "$profile_file" CHAT_KV_CACHE_BYTES)
      share=$(setting "$profile_file" CHAT_GPU_MEMORY_UTILIZATION)
      tool_parser=$(setting "$profile_file" CHAT_TOOL_CALL_PARSER)
      reasoning_parser=$(setting "$profile_file" CHAT_REASONING_PARSER)
      launch chat "$log" -- "$repo" --revision "$revision" --served-model-name "$served" \
        --host 127.0.0.1 --port "$port" \
        --max-model-len "$max_len" --max-num-seqs "$max_seqs" \
        --kv-cache-memory-bytes "$cache_bytes" --gpu-memory-utilization "$share" \
        --enable-auto-tool-choice --tool-call-parser "$tool_parser" --reasoning-parser "$reasoning_parser"
      ;;
    embed)
      repo=$(setting "$retrieval_file" EMBED_MODEL_REPO)
      revision=$(setting "$retrieval_file" EMBED_MODEL_REVISION)
      served=$(setting "$retrieval_file" EMBED_MODEL_ID)
      max_len=$(setting "$retrieval_file" EMBED_MAX_MODEL_LEN)
      cache_bytes=$(setting "$retrieval_file" EMBED_KV_CACHE_BYTES)
      share=$(setting "$retrieval_file" EMBED_GPU_MEMORY_UTILIZATION)
      launch embed "$log" VLLM_ENABLE_V1_MULTIPROCESSING=0 -- "$repo" --revision "$revision" --served-model-name "$served" \
        --runner pooling --host 127.0.0.1 --port "$port" --max-model-len "$max_len" \
        --kv-cache-memory-bytes "$cache_bytes" \
        --gpu-memory-utilization "$share"
      ;;
    rerank)
      repo=$(setting "$retrieval_file" RERANK_MODEL_REPO)
      revision=$(setting "$retrieval_file" RERANK_MODEL_REVISION)
      served=$(setting "$retrieval_file" RERANK_MODEL_ID)
      max_len=$(setting "$retrieval_file" RERANK_MAX_MODEL_LEN)
      cache_bytes=$(setting "$retrieval_file" RERANK_KV_CACHE_BYTES)
      share=$(setting "$retrieval_file" RERANK_GPU_MEMORY_UTILIZATION)
      overrides=$(setting "$retrieval_file" RERANK_HF_OVERRIDES)
      template=$(setting "$retrieval_file" RERANK_CHAT_TEMPLATE)
      launch rerank "$log" VLLM_ENABLE_V1_MULTIPROCESSING=0 -- "$repo" --revision "$revision" --served-model-name "$served" \
        --runner pooling --host 127.0.0.1 --port "$port" --max-model-len "$max_len" \
        --kv-cache-memory-bytes "$cache_bytes" \
        --gpu-memory-utilization "$share" \
        --hf-overrides "$overrides" --chat-template "$model_dir/$template"
      ;;
  esac
}

# True while the server's group has a member. Its first process is counted on its own too, for the moment between
# its start and its os.setsid(), when it does not lead a group yet.
server_alive() {
  group_alive "$1" || kill -0 "$1" 2>/dev/null
}

# Ends the server's process group and waits until the group has no member. Returns non-zero, having said so, when a
# member survives SIGKILL.
stop_one() {
  name=$1
  pid=$(running_pid "$name")
  if [ -z "$pid" ]; then
    rm -f "$run_dir/$name.pid"
    say "the $name server is not running"
    return 0
  fi
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || :
  waited=0
  while server_alive "$pid" && [ "$waited" -lt 60 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if server_alive "$pid"; then
    say "the $name server did not end within 60 seconds of SIGTERM; sending SIGKILL to its process group"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || :
    waited=0
    while server_alive "$pid" && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if server_alive "$pid"; then
      say "processes of the $name server's group ($pid) are still running after SIGKILL; its pid file is kept"
      return 1
    fi
  fi
  rm -f "$run_dir/$name.pid"
  say "stopped the $name server"
}

# Waits for chat's /health while the others wait to start: up to 900 seconds, as setup waits.
wait_for_chat() {
  port=$(port_of chat)
  waited=0
  while :; do
    [ -n "$(running_pid chat)" ] || {
      say "the chat server ended while starting; its log: $run_dir/chat.log"
      exit 1
    }
    if curl -q --noproxy '*' --fail --silent --output /dev/null --max-time 5 "http://127.0.0.1:$port/health"; then
      return 0
    fi
    if [ "$waited" -ge 900 ]; then
      say "the chat server did not answer /health within 900 seconds; the others were not started"
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

# The names given, each checked, in the order chat, embed, rerank (or its reverse for stop); all three if none.
servers_of() {
  order=$1
  shift
  for given in "$@"; do
    case $given in
      chat | embed | rerank) ;;
      *) die "not a server: $given (servers: chat, embed, rerank)" ;;
    esac
  done
  for name in $order; do
    if [ "$#" -eq 0 ]; then
      printf '%s\n' "$name"
    else
      for given in "$@"; do
        if [ "$given" = "$name" ]; then
          printf '%s\n' "$name"
          break
        fi
      done
    fi
  done
}

command=${1:-}
[ "$#" -eq 0 ] || shift
case $command in
  start)
    [ "$#" -ge 1 ] || die "usage: model/metal/servers.sh start <profile> [chat|embed|rerank ...]"
    profile=$1
    shift
    case $profile in
      '' | *[!A-Za-z0-9._-]*) die "not a profile name: $profile" ;;
    esac
    profile_file="$model_dir/profiles/$profile.env"
    [ -f "$profile_file" ] || die "model/profiles/$profile.env does not exist"
    names=$(servers_of 'chat embed rerank' "$@")
    started_chat=''
    for name in $names; do
      if [ "$name" != chat ] && [ "$started_chat" = yes ]; then
        wait_for_chat
        started_chat=''
      fi
      start_one "$name"
      [ "$name" != chat ] || started_chat=yes
    done
    ;;
  stop)
    names=$(servers_of 'rerank embed chat' "$@")
    survived=''
    for name in $names; do
      stop_one "$name" || survived="$survived $name"
    done
    [ -z "$survived" ] || {
      say "not every server could be stopped:$survived"
      exit 1
    }
    ;;
  status)
    [ "$#" -eq 0 ] || die "usage: model/metal/servers.sh status"
    for name in chat embed rerank; do
      pid=$(running_pid "$name")
      if [ -n "$pid" ]; then
        port=$(port_of "$name")
        printf '%s running (pid %s, port %s)\n' "$name" "$pid" "$port"
      else
        printf '%s stopped\n' "$name"
      fi
    done
    ;;
  *)
    die "usage: model/metal/servers.sh start <profile> [chat|embed|rerank ...] | stop [chat|embed|rerank ...] | status"
    ;;
esac
