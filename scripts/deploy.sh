#!/usr/bin/env bash
# Deploy with your own settings, without ever putting them in a tracked file.
#
# `wrangler.jsonc` is committed with placeholders on purpose: it is the template an
# open-source clone starts from. Your real worker name, origin, and Slack allowlist live in
# `.deploy.env`, which is gitignored, and are injected here as CLI overrides.
#
# Overrides rather than a second config file: wrangler does not merge configs, so a local
# copy would silently miss any binding or migration added to the tracked one.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${DEPLOY_ENV_FILE:-.deploy.env}"

if [ ! -f "$ENV_FILE" ]; then
  cat >&2 <<EOF
No $ENV_FILE found. Create one (it is gitignored):

  WORKER_NAME=my-worker
  PUBLIC_URL=https://my-worker.example.workers.dev
  ALLOWED_CHANNELS=C0123456789
  ALLOWED_USERS=
  ALLOWED_TEAMS=T0123456789
  TEMPLATE_BOX_ID=
  CLOUDFLARE_ACCOUNT_ID=...

Everything except WORKER_NAME and PUBLIC_URL is optional.
EOF
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

: "${WORKER_NAME:?set WORKER_NAME in $ENV_FILE}"
: "${PUBLIC_URL:?set PUBLIC_URL in $ENV_FILE}"

args=(deploy --name "$WORKER_NAME" --var "PUBLIC_URL:$PUBLIC_URL")

# Only override what is actually set: an unset var keeps whatever wrangler.jsonc says,
# and the committed allowlists are empty, which fails closed.
for key in ALLOWED_CHANNELS ALLOWED_USERS ALLOWED_TEAMS TEMPLATE_BOX_ID BOX_MODEL BOX_PROVIDER; do
  value="${!key-}"
  [ -n "$value" ] && args+=(--var "$key:$value")
done

echo "Deploying as \"$WORKER_NAME\" → $PUBLIC_URL"
exec npx wrangler "${args[@]}" "$@"
