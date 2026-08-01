#!/usr/bin/env bash
# Generate .dev.vars for local development.
#
# BOX_API_KEY is copied out of the `box` CLI's own config (it stores a box_... key),
# so no secret is ever typed, pasted, or echoed. .dev.vars is gitignored.
set -euo pipefail

cd "$(dirname "$0")/.."

BOX_CONFIG="${BOX_CONFIG:-$HOME/Library/Application Support/ascii/box/config.json}"
[ -f "$BOX_CONFIG" ] || BOX_CONFIG="$HOME/.config/ascii/box/config.json"

if [ -f ".dev.vars" ]; then
  echo ".dev.vars already exists; refusing to overwrite. Delete it first to regenerate." >&2
  exit 1
fi

if [ ! -f "$BOX_CONFIG" ]; then
  echo "No box CLI config found. Run 'box login', or set BOX_API_KEY in .dev.vars by hand." >&2
  exit 1
fi

BOX_API_KEY="$(jq -er '.token' "$BOX_CONFIG")"
case "$BOX_API_KEY" in
  box_*) ;;
  *) echo "Token in $BOX_CONFIG does not look like a box_ API key." >&2; exit 1 ;;
esac

rand() { openssl rand -hex 32; }

umask 077
cat > .dev.vars <<EOF
BOX_API_KEY=$BOX_API_KEY
MCP_TOKEN_SECRET=$(rand)
API_TOKEN=$(rand)

# Slack is optional. The /api surface works without it.
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_SIGNING_SECRET=...
EOF

echo "Wrote .dev.vars (mode $(stat -f '%OLp' .dev.vars 2>/dev/null || stat -c '%a' .dev.vars))."
echo "API_TOKEN for scripts:  grep '^API_TOKEN=' .dev.vars | cut -d= -f2"
