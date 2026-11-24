#!/bin/sh
# Writes platform/identity/.env: a value for every variable named in platform/identity/.env.example. The Keycloak
# bootstrap administrator and the secret of each client that holds one get a random value, made by the pinned Node
# image on the local Docker daemon, with no network. Each realm user's password is that user's username
# (IDENTITY_DANA_PASSWORD is dana.desk), with no Docker call: the people are synthetic, the lab is published on this
# machine only, and their passwords are typed by hand at the sign-in page.
#
#   platform/identity/setup.sh
#
# Run again, it keeps every value already set and writes one for each variable that has none: a variable with no
# line is appended, and a line with an empty value (NAME=) is given one. A realm user's password line that holds
# anything but the username is set to the username, in place. Every other line is kept as it is, in place.
# If platform/identity/.env already holds every variable, with the usernames as the users' passwords, nothing is
# changed. It never prints a value.
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

# ---------- the variables to set ----------

# Sets person to the username whose password $1 names; fails for every other variable.
person_password() {
  case $1 in
    IDENTITY_DANA_PASSWORD) person=dana.desk ;;
    IDENTITY_MORGAN_PASSWORD) person=morgan.medinfo ;;
    IDENTITY_RILEY_PASSWORD) person=riley.reviewer ;;
    IDENTITY_AVERY_PASSWORD) person=avery.auditor ;;
    *) return 1 ;;
  esac
}

# A realm user's password is set when the file has a line NAME=<username> and no line NAME= with anything else.
# Any other variable is set when a line NAME=<something> holds it. With no file, none is.
to_set=''
for name in $names; do
  if person_password "$name"; then
    if ! { [ -e "$env_file" ] && grep -qFx "$name=$person" "$env_file" &&
      ! grep "^$name=" "$env_file" | grep -qvFx "$name=$person"; }; then
      to_set="$to_set $name"
    fi
  elif ! { [ -e "$env_file" ] && grep -q "^$name=." "$env_file"; }; then
    to_set="$to_set $name"
  fi
done
to_set=${to_set# }
if [ -z "$to_set" ]; then
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

# Sets value to the value $1 takes: a realm user's username for that user's password, with no Docker call, and a
# new random value of the kind $1 takes for every other variable. Stops the script for a name it does not know, or
# a failure.
make_value() {
  if person_password "$1"; then
    value=$person
    return 0
  fi
  case $1 in
    IDENTITY_ADMIN_USERNAME) value=$(random_hex 4) && value="admin-$value" || value='' ;;
    IDENTITY_ADMIN_PASSWORD) value=$(random_hex 24) || value='' ;;
    IDENTITY_DESK_CLIENT_SECRET | IDENTITY_INTAKE_HANDWRITTEN_CLIENT_SECRET | IDENTITY_INTAKE_STRANDS_CLIENT_SECRET | \
      IDENTITY_EXPERT_CLIENT_SECRET | IDENTITY_ORCHESTRATOR_CLIENT_SECRET | IDENTITY_EVALUATION_CLIENT_SECRET | \
      IDENTITY_KNOWLEDGE_GATE_CLIENT_SECRET | IDENTITY_CONTACT_FORM_CLIENT_SECRET | IDENTITY_LAB_EXPLORER_CLIENT_SECRET)
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

is_to_set() {
  case " $to_set " in
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
  # Each line is copied as it is, except a line NAME=... of a variable to set: a line NAME= of a variable with no
  # value, or a realm user's password line that does not hold the username. It is given the value in place.
  # A last line without a newline gets one, so an appended variable starts a line of its own.
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      *=*)
        name=${line%%=*}
        if is_to_set "$name"; then
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
for name in $to_set; do
  if ! { [ -e "$env_file" ] && grep -q "^$name=" "$env_file"; }; then
    make_value "$name"
    printf '%s=%s\n' "$name" "$value" >>"$tmp_env"
  fi
done

if [ -e "$env_file" ]; then
  done_message="set in platform/identity/.env (mode 600) a value for: $to_set"
else
  done_message="wrote platform/identity/.env (mode 600) with a value for: $to_set"
fi
if ! mv -f "$tmp_env" "$env_file"; then
  say "could not move $tmp_env to platform/identity/.env."
  exit 1
fi
say "$done_message"
say "start the provider with: docker compose -f platform/identity/compose.yaml up -d --wait"
