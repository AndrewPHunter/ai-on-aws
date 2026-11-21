#!/bin/sh
# Checks a running stack end to end, from inside its network: sign-in of both realm users through the
# client and Keycloak, the cookies, the session, refused callbacks, a cross-site POST, sign-out; each
# agent's and the case system's refusal of a request without a token; an inquiry to each agent as each
# user, through to the end of its run; the reviewer role enforced on a review. Then, on the Docker host,
# that the client wrote no revocation failure while the gate ran. See platform/identity/README.md.
#
#   platform/identity/stack-gate.sh <compose-project>
#
# <compose-project> is the compose project the whole stack runs in: ai-on-aws for the lab. The gate joins
# that project's default network, <compose-project>_default.
#
# Exit codes: 0 every statement holds, 1 a statement does not hold (the report lists every one that did
# not), 2 could not run, with the reason on standard error: the project's network is missing, Compose
# failed before a gate program ran, or a program produced no report. A report goes to standard output
# only with exit 0 or 1, and nothing else ever does.
set -eu

say() {
  printf 'stack-gate: %s\n' "$*" >&2
}

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  say "usage: platform/identity/stack-gate.sh <compose-project>"
  exit 2
fi
project=$1

if ! command -v docker >/dev/null 2>&1; then
  say "docker was not found on PATH."
  exit 2
fi
if ! docker version --format '{{.Server.Version}}' >/dev/null; then
  say "the local Docker daemon does not answer (docker version failed)."
  exit 2
fi

identity_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
if [ ! -f "$identity_dir/.env" ]; then
  say "platform/identity/.env does not exist. Run platform/identity/setup.sh first."
  exit 2
fi
network="${project}_default"
if ! docker network inspect --format '{{.Name}}' "$network" >/dev/null 2>&1; then
  say "there is no network $network: is the stack running in compose project $project?"
  exit 2
fi

gate_compose() {
  env IDENTITY_GATE_NETWORK="$network" docker compose -f "$identity_dir/gate/compose.yaml" \
    --env-file "$identity_dir/.env" "$@"
}

# The image is built first, with all of the build's output on standard error.
if ! gate_compose build stack-gate >&2; then
  say "building the gate's image failed (see the build output above)."
  exit 2
fi

report=$(mktemp)
merged=$(mktemp)
trap 'rm -f "$report" "$merged"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
rc=0
gate_compose run --rm -T stack-gate >"$report" || rc=$?
# Compose itself also exits 1 when it fails before the gate runs, so a report must be there too.
if { [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; } || [ ! -s "$report" ]; then
  say "the stack gate produced no report (exit $rc): Compose failed before the gate ran, or the gate could not run."
  exit 2
fi

# The client's output since the gate started: only the number of revocation failures is kept.
failures=unreadable
client=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=client 2>/dev/null || :)
if [ -n "$client" ]; then
  if logs=$(docker logs --since "$started" "$client" 2>&1); then
    failures=$(printf '%s\n' "$logs" | grep -c 'revoking the refresh token at the identity provider failed' || :)
  fi
fi
unset logs
if [ "$failures" = unreadable ]; then
  say "the client's output could not be read; the revocation statement is reported as not checked."
fi

rc=0
env REVOCATION_FAILURES="$failures" IDENTITY_GATE_NETWORK="$network" docker compose -f "$identity_dir/gate/compose.yaml" \
  --env-file "$identity_dir/.env" run --rm -T -e REVOCATION_FAILURES="$failures" stack-gate \
  node /repo/platform/identity/gate/stack-gate-merge.ts <"$report" >"$merged" || rc=$?
if { [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; } && [ -s "$merged" ]; then
  cat "$merged"
  exit "$rc"
fi
say "merging the client's output into the report produced no report (exit $rc)."
exit 2
