#!/bin/sh
# Empties the desk's inbox and the review queue of the running lab: deletes the two volumes that hold the client's
# inquiries and runs (<project>_inquiries) and the case system's cases (<project>_cases), then starts the client and
# the case system again, with empty stores, and waits until both are healthy. Every other service is left as it
# was, and no other volume is named: the label index is kept.
#
#   ./reset-demo-data.sh          asks first, naming the project and the two volumes; only the answer yes goes on
#   ./reset-demo-data.sh --yes    does not ask
#
# The Compose project is ai-on-aws, or the value of COMPOSE_PROJECT_NAME when that is set and not empty. It is
# passed to every docker compose call with -p and is the prefix of both volume names. Works from any directory:
# Compose is run from the repository root, found from this script's own path, with the root compose.yaml.
# A volume that does not exist is not an error. It reads no .env file itself; Compose reads what it needs.
#
# Steps: stop the client and the case system, remove their containers, delete the two volumes, start the two
# services again without their dependencies, and wait for them to be healthy. A failed step stops the script and
# says what state things are in and how to start the two services again.
#
# Exit codes: 0 both volumes were deleted (or did not exist) and the client and the case system are healthy again,
#               each with a new, empty volume,
#             1 the answer was not yes (nothing was deleted), or a step failed (the message says which),
#             2 could not run: an argument other than --yes, no terminal to ask on and no --yes, a project name
#               Compose does not accept, no Docker, or the daemon does not answer. Nothing was changed.
set -eu

say() {
  printf 'reset-demo-data: %s\n' "$*" >&2
}

usage() {
  say "usage: reset-demo-data.sh [--yes]"
}

# ---------- arguments and environment ----------

assume_yes=false
case $# in
  0) ;;
  1)
    if [ "$1" = --yes ]; then
      assume_yes=true
    else
      say "unknown argument: $1"
      usage
      exit 2
    fi
    ;;
  *)
    say "too many arguments."
    usage
    exit 2
    ;;
esac

project=${COMPOSE_PROJECT_NAME:-ai-on-aws}
# Compose accepts lowercase letters, digits, dashes and underscores, starting with a letter or a digit.
case $project in
  [a-z0-9]*) ;;
  *) project_bad=true ;;
esac
case $project in
  *[!a-z0-9_-]*) project_bad=true ;;
esac
if [ "${project_bad:-false}" = true ]; then
  say "COMPOSE_PROJECT_NAME is not a project name Compose accepts (lowercase letters, digits, - and _): $project"
  exit 2
fi

inquiries_volume="${project}_inquiries"
cases_volume="${project}_cases"

if ! command -v docker >/dev/null 2>&1; then
  say "docker was not found on PATH."
  exit 2
fi
if ! docker version --format '{{.Server.Version}}' >/dev/null; then
  say "the local Docker daemon does not answer (docker version failed)."
  exit 2
fi

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
cd -- "$repo_dir"

compose() {
  docker compose -p "$project" -f compose.yaml "$@"
}

start_again="docker compose -p $project up -d --wait --no-deps client case-system"

# ---------- the question ----------

if [ "$assume_yes" = false ]; then
  if [ ! -t 0 ]; then
    say "standard input is not a terminal, so there is no one to ask; run it with --yes to delete without asking."
    exit 2
  fi
  say "this deletes 2 volumes of the Compose project $project:"
  say "  $inquiries_volume  (the client's inquiries and runs)"
  say "  $cases_volume  (the case system's cases)"
  say "The label index is kept. This cannot be undone."
  printf 'reset-demo-data: type yes to go on: ' >&2
  if ! IFS= read -r answer; then
    answer=''
  fi
  if [ "$answer" != yes ]; then
    say "the answer was not yes; nothing was deleted."
    exit 1
  fi
fi

# ---------- stop and remove the two services ----------

if ! compose stop client case-system; then
  say "stopping the client and the case system failed. No volume was deleted; either service may now be stopped."
  say "start them again, from the repository root, with:$start_again"
  exit 1
fi
if ! compose rm -f client case-system; then
  say "removing the containers of the client and the case system failed. No volume was deleted; both services are stopped."
  say "start them again, from the repository root, with:$start_again"
  exit 1
fi

# ---------- delete the two volumes ----------

if ! volumes=$(docker volume ls --format '{{.Name}}'); then
  say "listing the volumes failed. No volume was deleted; the client and the case system are stopped."
  say "start them again, from the repository root, with:$start_again"
  exit 1
fi

deleted=''
for volume in "$inquiries_volume" "$cases_volume"; do
  if ! printf '%s\n' "$volumes" | grep -Fqx -- "$volume"; then
    say "$volume does not exist; nothing to delete."
    continue
  fi
  if ! docker volume rm -- "$volume" >/dev/null; then
    say "deleting $volume failed. Deleted before it: ${deleted:-none}. The client and the case system are stopped."
    say "start them again, from the repository root, with:$start_again"
    exit 1
  fi
  deleted="${deleted:+$deleted }$volume"
  say "deleted $volume."
done

# ---------- start the two services again ----------

if ! compose up -d --wait --no-deps client case-system; then
  say "the client and the case system did not both come up healthy. Deleted: ${deleted:-none}."
  say "see what happened, from the repository root, with: docker compose -p $project logs client case-system"
  exit 1
fi

say "the client and the case system are healthy, with empty stores. Deleted: ${deleted:-none}. The label index was kept."
