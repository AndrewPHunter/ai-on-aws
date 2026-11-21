#!/bin/sh
# Checks a running identity service for real: discovery from inside the stack's network, sign-in of both
# realm users through the Authorization Code flow with PKCE, the signature and claims of each access token,
# and refusal of the password grant. See platform/identity/README.md.
#
#   platform/identity/gate.sh <compose-project>
#
# <compose-project> is the compose project the identity service runs in: ai-on-aws for the whole lab
# (docker compose up from the repository root), or the name given with -p when the service was started
# on its own. The gate joins that project's default network, <compose-project>_default.
#
# Exit codes: 0 every statement holds, 1 a statement does not hold (the report names it),
#             2 could not run, with the reason on standard error: the project's network is missing,
#             Compose failed before the gate program ran, or the program produced no report.
# A report goes to standard output only with exit 0 or 1, and nothing else ever does.
set -eu

say() {
  printf 'gate: %s\n' "$*" >&2
}

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  say "usage: platform/identity/gate.sh <compose-project>"
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
  say "there is no network $network: is the identity service running in compose project $project?"
  exit 2
fi

gate_compose() {
  env IDENTITY_GATE_NETWORK="$network" docker compose -f "$identity_dir/gate/compose.yaml" \
    --env-file "$identity_dir/.env" "$@"
}

# Standard output carries the gate's JSON report and nothing else, so the image is built first, with all of
# the build's output sent to standard error.
if ! gate_compose build gate >&2; then
  say "building the gate's image failed (see the build output above)."
  exit 2
fi

report=$(mktemp)
trap 'rm -f "$report"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The image now exists, so run does not build it again (this Compose's run has no --no-build flag). The
# report is held until it is known to be one: Compose itself also exits 1 when it fails before the gate runs.
rc=0
gate_compose run --rm -T gate >"$report" || rc=$?
if { [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; } && [ -s "$report" ]; then
  cat "$report"
  exit "$rc"
fi
say "the gate produced no report (exit $rc): Compose failed before the gate ran, or the gate could not run."
exit 2
