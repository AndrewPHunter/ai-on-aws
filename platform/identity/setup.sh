#!/bin/sh
# Writes platform/identity/.env: a random value for every variable named in platform/identity/.env.example
# (the Keycloak bootstrap administrator, the desk client's secret and each realm user's password).
# The values are made by the pinned Node image on the local Docker daemon, with no network.
#
#   platform/identity/setup.sh
#
# If platform/identity/.env already holds every variable, nothing is changed. It never prints a value.
#
# Exit codes: 0 platform/identity/.env holds every variable (written now, or already there),
#             1 platform/identity/.env exists but lacks a variable, or could not be written,
#             2 could not run (no Docker, or the daemon does not answer).
set -eu

NODE_IMAGE=node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

say() {
  printf 'setup: %s\n' "$*" >&2
}

if ! command -v docker >/dev/null 2>&1; then
  say "docker was not found on PATH."
  exit 2
fi
if ! docker version --format '{{.Server.Version}}' >/dev/null; then
  say "the local Docker daemon does not answer (docker version failed)."
  exit 2
fi

identity_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
example="$identity_dir/.env.example"
env_file="$identity_dir/.env"

names=$(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*$/\1/p' "$example")
if [ -z "$names" ]; then
  say "platform/identity/.env.example names no variable."
  exit 2
fi

# ---------- an existing file is kept as it is, if it is whole ----------

if [ -e "$env_file" ]; then
  for name in $names; do
    if ! grep -q "^$name=." "$env_file"; then
      say "platform/identity/.env exists but has no value for $name. Add it, or remove the file and run setup again."
      exit 1
    fi
  done
  say "platform/identity/.env already holds every variable; nothing was changed."
  exit 0
fi

# ---------- a new file ----------

# One random value per call: <bytes> random bytes as hex, made in the pinned Node image with no network.
random_hex() {
  docker run --rm --network none "$NODE_IMAGE" \
    node -e 'process.stdout.write(require("node:crypto").randomBytes(Number(process.argv[1])).toString("hex"))' "$1"
}

tmp_env="$identity_dir/.env.tmp.$$"
trap 'rm -f "$tmp_env"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! (umask 077 && set -C && : >"$tmp_env"); then
  say "could not create $tmp_env."
  exit 1
fi

{
  printf '# Written by platform/identity/setup.sh. Ignored by git; never commit it.\n'
  for name in $names; do
    case $name in
      IDENTITY_ADMIN_USERNAME) value=$(random_hex 4) && value="admin-$value" || value='' ;;
      IDENTITY_ADMIN_PASSWORD | IDENTITY_RILEY_PASSWORD | IDENTITY_DANA_PASSWORD) value=$(random_hex 24) || value='' ;;
      IDENTITY_DESK_CLIENT_SECRET) value=$(random_hex 32) || value='' ;;
      *)
        say "setup does not know how to make a value for $name, which platform/identity/.env.example names."
        exit 1
        ;;
    esac
    case $value in
      '' | admin-) say "making a value for $name failed."; exit 1 ;;
    esac
    printf '%s=%s\n' "$name" "$value"
  done
} >>"$tmp_env"

if ! mv -f "$tmp_env" "$env_file"; then
  say "could not move $tmp_env to platform/identity/.env."
  exit 1
fi
say "wrote platform/identity/.env (mode 600) with a value for: $(printf '%s ' $names | sed 's/ $//')"
say "start the provider with: docker compose -f platform/identity/compose.yaml up -d --wait"
