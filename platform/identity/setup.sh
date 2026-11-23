#!/bin/sh
# Writes platform/identity/.env: a random value for every variable named in platform/identity/.env.example
# (the Keycloak bootstrap administrator, the secret of each client that holds one, and each realm user's password).
# The values are made by the pinned Node image on the local Docker daemon, with no network.
#
#   platform/identity/setup.sh
#
# Run again, it keeps every value already set and writes one for each variable that has none: a variable with no
# line is appended, and a line with an empty value (NAME=) is given one. Every other line is kept as it is, in place.
# If platform/identity/.env already holds every variable, nothing is changed. It never prints a value.
#
# Exit codes: 0 platform/identity/.env holds every variable (written or completed now, or already there),
#             1 a value could not be made (a variable setup does not know, or the image failed), or the file could
#               not be written; platform/identity/.env is then as it was,
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

# ---------- the variables that have no value ----------

# A variable has a value when a line NAME=<something> holds it. With no file, none has.
missing=''
for name in $names; do
  if ! { [ -e "$env_file" ] && grep -q "^$name=." "$env_file"; }; then
    missing="$missing $name"
  fi
done
missing=${missing# }
if [ -z "$missing" ]; then
  say "platform/identity/.env already holds every variable; nothing was changed."
  exit 0
fi

# ---------- a file with a value for each of them ----------

# One random value per call: <bytes> random bytes as hex, made in the pinned Node image with no network.
# Its standard input is closed, so it never reads the lines of the file being copied.
random_hex() {
  docker run --rm --network none "$NODE_IMAGE" \
    node -e 'process.stdout.write(require("node:crypto").randomBytes(Number(process.argv[1])).toString("hex"))' "$1" </dev/null
}

# Sets value to a new random value of the kind $1 takes; stops the script for a name it does not know, or a failure.
make_value() {
  case $1 in
    IDENTITY_ADMIN_USERNAME) value=$(random_hex 4) && value="admin-$value" || value='' ;;
    IDENTITY_ADMIN_PASSWORD | IDENTITY_RILEY_PASSWORD | IDENTITY_DANA_PASSWORD | IDENTITY_MORGAN_PASSWORD | \
      IDENTITY_AVERY_PASSWORD) value=$(random_hex 24) || value='' ;;
    IDENTITY_DESK_CLIENT_SECRET | IDENTITY_INTAKE_HANDWRITTEN_CLIENT_SECRET | IDENTITY_INTAKE_STRANDS_CLIENT_SECRET | \
      IDENTITY_EXPERT_CLIENT_SECRET | IDENTITY_ORCHESTRATOR_CLIENT_SECRET | IDENTITY_EVALUATION_CLIENT_SECRET | \
      IDENTITY_KNOWLEDGE_GATE_CLIENT_SECRET)
      value=$(random_hex 32) || value='' ;;
    *)
      say "setup does not know how to make a value for $1, which platform/identity/.env.example names."
      exit 1
      ;;
  esac
  case $value in
    '' | admin-) say "making a value for $1 failed."; exit 1 ;;
  esac
}

is_missing() {
  case " $missing " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

tmp_env="$identity_dir/.env.tmp.$$"
trap 'rm -f "$tmp_env"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! (umask 077 && set -C && : >"$tmp_env"); then
  say "could not create $tmp_env."
  exit 1
fi

if [ -e "$env_file" ]; then
  # Each line is copied as it is, except a line NAME= of a variable with no value, which is given one.
  # A last line without a newline gets one, so an appended variable starts a line of its own.
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      *=)
        name=${line%=}
        if is_missing "$name"; then
          make_value "$name"
          printf '%s=%s\n' "$name" "$value"
          continue
        fi
        ;;
    esac
    printf '%s\n' "$line"
  done <"$env_file" >>"$tmp_env"
else
  printf '# Written by platform/identity/setup.sh. Ignored by git; never commit it.\n' >>"$tmp_env"
fi

# A variable with no line at all is appended.
for name in $missing; do
  if ! { [ -e "$env_file" ] && grep -q "^$name=" "$env_file"; }; then
    make_value "$name"
    printf '%s=%s\n' "$name" "$value" >>"$tmp_env"
  fi
done

if [ -e "$env_file" ]; then
  done_message="added to platform/identity/.env (mode 600) a value for: $missing"
else
  done_message="wrote platform/identity/.env (mode 600) with a value for: $missing"
fi
if ! mv -f "$tmp_env" "$env_file"; then
  say "could not move $tmp_env to platform/identity/.env."
  exit 1
fi
say "$done_message"
say "start the provider with: docker compose -f platform/identity/compose.yaml up -d --wait"
