#!/bin/sh
# Checks, from inside a running stack's network, that the realm, the agents, the tool servers and the client
# agree: each of the four agents', the case system's and the retrieval service's refusal of a request without a token;
# sign-in of the four people through the client and Keycloak, the cookies, refused callbacks, what each may
# do and a cross-site POST; what each may and may not do through the client; an inquiry to each intake agent
# and a question to the label expert, through each agent's exchange to its tool server and the end of the run;
# an inquiry to the orchestrator, through its delegations to the intake agent on Strands and the label expert
# and on to their tool servers; that a run read back holds no steps and its trace is read by the auditor alone;
# who may read an inquiry another person entered and start a run on it; tokens the gate gets itself,
# presented to each service and agent; and sign-out. Then, on the Docker host, that the client wrote no
# revocation failure while the gate ran. See platform/identity/README.md.
#
# It changes the stack it is run against: it enters four inquiries, all from the sender "Dr Gate,
# gate@example.org", and up to three cases may be opened from them: one by each intake agent from its own
# inquiry, and one by the intake agent on Strands from the orchestrator's. It also starts a run of the label
# expert, which writes nothing, on the first of those inquiries, and does not wait for it.
#
#   platform/identity/stack-gate.sh <compose-project>
#
# <compose-project> is the compose project the whole stack runs in: ai-on-aws for the lab. The gate joins
# that project's default network, <compose-project>_default.
#
# Exit codes: 0 every statement holds, 1 a statement does not hold (the report lists every one that did
# not; a statement the stack could not show, such as one that needs a model server, is listed under
# not_checked and is neither), 2 could not run, with the reason on standard error: the project's network is missing, Compose
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

# Each checkout of the repository gets its own gate image and compose project, named from the checkout's path,
# so a gate run from one checkout never runs an image another checkout built.
repo_dir=$(dirname -- "$(dirname -- "$identity_dir")")
checkout=$(printf '%s' "$repo_dir" | cksum | cut -d ' ' -f 1)
IDENTITY_GATE_IMAGE_TAG="checkout-$checkout"
export IDENTITY_GATE_IMAGE_TAG
gate_project="ai-on-aws-identity-gate-$checkout"
say "image ai-on-aws-identity-gate:$IDENTITY_GATE_IMAGE_TAG"

gate_compose() {
  env IDENTITY_GATE_NETWORK="$network" docker compose -p "$gate_project" -f "$identity_dir/gate/compose.yaml" \
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
  say "the client's output could not be read; the revocation statement is reported as failed, since it was not checked."
fi

rc=0
env REVOCATION_FAILURES="$failures" IDENTITY_GATE_NETWORK="$network" docker compose -p "$gate_project" -f "$identity_dir/gate/compose.yaml" \
  --env-file "$identity_dir/.env" run --rm -T -e REVOCATION_FAILURES="$failures" stack-gate \
  node /repo/platform/identity/gate/stack-gate-merge.ts <"$report" >"$merged" || rc=$?
if { [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; } && [ -s "$merged" ]; then
  cat "$merged"
  exit "$rc"
fi
say "merging the client's output into the report produced no report (exit $rc)."
exit 2
