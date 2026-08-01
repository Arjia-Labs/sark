import type { BoxClient } from "./client.ts";

/**
 * Point the box's Claude Code at this Worker's MCP endpoint.
 *
 * The callback URL arrives as a box env var (set at fork time) and the bearer token is
 * written into a file immediately before registration, so neither is ever interpolated
 * into a shell string here - the shell reads them itself. The token deliberately does
 * NOT travel in the box env: env is fixed at fork time and would pin a box to one token
 * for its whole life, which is exactly what we do not want for a credential that has to
 * expire. Writing it per registration is what makes rotation possible.
 */
export interface BootstrapResult {
  ok: boolean;
  detail: string;
}

/** Written to ~/.claude/settings.json so MCP tool calls need no interactive approval. */
const SETTINGS = JSON.stringify(
  {
    permissions: {
      allow: [
        "mcp__slack",
        "mcp__slack__slack_post_message",
        "mcp__slack__slack_update_message",
        "mcp__slack__slack_add_reaction",
        "mcp__slack__slack_upload_file",
        "mcp__slack__slack_get_thread",
      ],
    },
    enableAllProjectMcpServers: true,
  },
  null,
  2,
);

const SERVER_NAME = "slack";

/**
 * Handoff location for the bearer token. Removed by the script that consumes it.
 *
 * Relative on purpose: the Box files API rejects absolute paths
 * ("Path must be relative to the Box work directory"), and `command` runs from that
 * same work directory, so both sides agree on where this is.
 */
const TOKEN_PATH = ".slack-mcp-token";

export async function bootstrapMcp(
  box: BoxClient,
  boxId: string,
  token: string,
): Promise<BootstrapResult> {
  await box.writeFile(boxId, TOKEN_PATH, token);

  const script = [
    "set -e",
    'if [ -z "${SLACK_MCP_URL:-}" ]; then',
    '  echo "missing SLACK_MCP_URL in box env" >&2; exit 3',
    "fi",
    `if [ ! -s ${TOKEN_PATH} ]; then`,
    `  echo "missing ${TOKEN_PATH}" >&2; exit 4`,
    "fi",
    `SLACK_MCP_TOKEN="$(cat ${TOKEN_PATH})"`,
    // The token now lives in the MCP registration; no reason to leave a second copy around.
    `rm -f ${TOKEN_PATH}`,
    "mkdir -p ~/.claude",
    `cat > ~/.claude/settings.json <<'SETTINGS_EOF'\n${SETTINGS}\nSETTINGS_EOF`,
    // Re-registering is how a box picks up a freshly minted token.
    `claude mcp remove --scope user ${SERVER_NAME} >/dev/null 2>&1 || true`,
    `claude mcp add --scope user --transport http ${SERVER_NAME} "$SLACK_MCP_URL" ` +
      '--header "Authorization: Bearer $SLACK_MCP_TOKEN"',
    "echo BOOTSTRAP_OK",
  ].join("\n");

  const r = await box.command(boxId, script, { timeoutSeconds: 45 });
  if (r.exitCode !== 0 || !r.stdout.includes("BOOTSTRAP_OK")) {
    // Do not leave the token sitting in /tmp if the script died before consuming it.
    await box.command(boxId, `rm -f ${TOKEN_PATH}`, { timeoutSeconds: 15 }).catch(() => {});
    // Sandbox output can echo the command that failed, token and all. This detail is
    // log-only, but a credential should not be sitting in the logs either.
    const output = (r.stderr || r.stdout).split(token).join("<redacted>").slice(0, 500);
    return { ok: false, detail: `mcp registration failed (exit ${r.exitCode}): ${output}` };
  }
  return { ok: true, detail: "registered" };
}

/** Best-effort health check; a failure here is worth surfacing but not fatal. */
export async function verifyMcp(box: BoxClient, boxId: string): Promise<BootstrapResult> {
  const r = await box.command(boxId, "claude mcp list 2>&1", { timeoutSeconds: 45 });
  const line = r.stdout.split("\n").find((l) => l.startsWith(`${SERVER_NAME}:`)) ?? "";
  const connected = /✓|connected/i.test(line);
  return {
    ok: connected,
    detail: line.trim() || r.stdout.trim().slice(0, 300) || "no output from `claude mcp list`",
  };
}
