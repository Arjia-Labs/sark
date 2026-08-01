#!/usr/bin/env bash
# Run a wrangler command against YOUR worker.
#
# `wrangler.jsonc` is the public template, so the name in it is a placeholder. Bare
# `wrangler tail` / `wrangler dev` therefore look for a worker that does not exist on your
# account ("This Worker does not exist on your account", code 10007). This reads
# WORKER_NAME from `.deploy.env` and passes it explicitly.
#
# `tail` takes the worker as a positional argument; everything else takes --name.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${DEPLOY_ENV_FILE:-.deploy.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "./$ENV_FILE"
  set +a
fi

cmd="${1:-}"
[ -n "$cmd" ] || { echo "usage: $0 <wrangler-command> [args...]" >&2; exit 1; }
shift

if [ -z "${WORKER_NAME:-}" ]; then
  # No .deploy.env is a legitimate state (a fresh clone that has not deployed yet).
  # Fall through to plain wrangler rather than inventing a name.
  echo "No WORKER_NAME in $ENV_FILE; using the name in wrangler.jsonc." >&2
  exec npx wrangler "$cmd" "$@"
fi

case "$cmd" in
  tail) exec npx wrangler tail "$WORKER_NAME" "$@" ;;
  *)    exec npx wrangler "$cmd" --name "$WORKER_NAME" "$@" ;;
esac
