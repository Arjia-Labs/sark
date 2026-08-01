#!/usr/bin/env bash
# Fail if personal settings have leaked into the tracked wrangler.jsonc.
#
# The committed config is a template. Real values belong in .deploy.env (gitignored) and are
# injected by scripts/deploy.sh. This runs in CI, and is worth wiring up as a pre-commit hook:
#
#   ln -s ../../scripts/check-config-clean.sh .git/hooks/pre-commit
#
# It reads the file as tracked by git, not the working copy, so a locally-edited config
# doesn't trip it - only one that is actually about to be committed.
set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="wrangler.jsonc"
# Whole-line comments are stripped first: the file documents the expected format with
# example ids, and those examples must not read as real ones.
staged="$(
  { git show ":$CONFIG" 2>/dev/null || cat "$CONFIG"; } | grep -vE '^[[:space:]]*//'
)"
fail=0

note() {
  echo "  ✗ $1" >&2
  fail=1
}

echo "Checking $CONFIG for personal settings…"

grep -qE '"account_id"[[:space:]]*:' <<<"$staged" &&
  note 'account_id is set. Use the CLOUDFLARE_ACCOUNT_ID environment variable instead.'

grep -qE '"PUBLIC_URL"[[:space:]]*:[[:space:]]*"https://[^<]' <<<"$staged" &&
  note 'PUBLIC_URL is a real origin. It should stay "https://<your-worker>.workers.dev".'

for key in ALLOWED_CHANNELS ALLOWED_USERS ALLOWED_TEAMS TEMPLATE_BOX_ID; do
  grep -qE "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" <<<"$staged" &&
    note "$key is not empty. Put it in .deploy.env instead."
done

# Anything that looks like a real Slack or Box id, wherever it turns up.
grep -qE '"[CGD][A-Z0-9]{8,}[,"]|"T[A-Z0-9]{8,}"|box_[A-Za-z0-9]{8,}' <<<"$staged" &&
  note 'A literal Slack or Box id appears in the config.'

if [ "$fail" -ne 0 ]; then
  echo >&2
  echo "wrangler.jsonc is the public template. Deploy with: npm run deploy" >&2
  exit 1
fi

echo "  ✓ clean"
