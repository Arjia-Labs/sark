import type { ThreadSession } from "./do/ThreadSession.ts";

/** Caps. A single allowlisted channel member should not be able to run us out of anything. */
export const MAX_PROMPT_CHARS = 16_000;
export const MAX_QUEUED_PROMPTS = 20;

export interface Env {
  THREAD_SESSIONS: DurableObjectNamespace<ThreadSession>;

  // secrets
  BOX_API_KEY: string;
  MCP_TOKEN_SECRET: string;
  API_TOKEN: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;

  // vars
  BOX_BASE_URL: string;
  TEMPLATE_BOX_ID?: string;
  PUBLIC_URL: string;
  BOX_PROVIDER: string;
  BOX_MODEL?: string;
  BOX_TTL_SECONDS: string;
  IDLE_STOP_SECONDS: string;
  PROMPT_HARD_CAP_SECONDS: string;
  ALLOWED_CHANNELS: string;
  ALLOWED_USERS: string;
  ALLOWED_TEAMS: string;
}

export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function idList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Fail-closed allowlist. A mention is permitted when the team matches (or no team
 * restriction is configured) AND the channel or the user is explicitly listed.
 */
export function isAllowed(
  env: Env,
  who: { team?: string; channel?: string; user?: string },
): { ok: true } | { ok: false; reason: string } {
  const teams = idList(env.ALLOWED_TEAMS);
  if (teams.length && (!who.team || !teams.includes(who.team))) {
    return { ok: false, reason: "This workspace is not enabled for this bot." };
  }

  const channels = idList(env.ALLOWED_CHANNELS);
  const users = idList(env.ALLOWED_USERS);
  if (!channels.length && !users.length) {
    return {
      ok: false,
      reason: "No channels or users are allowlisted yet. Set ALLOWED_CHANNELS or ALLOWED_USERS.",
    };
  }
  if (who.channel && channels.includes(who.channel)) return { ok: true };
  if (who.user && users.includes(who.user)) return { ok: true };
  return { ok: false, reason: "This bot is not enabled in this channel." };
}
