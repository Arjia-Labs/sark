/**
 * Drive the bot without Slack.
 *
 *   npm run drive -- "list the files in your home dir"
 *   npm run drive -- --thread demo "now delete them"     # same thread => same sandbox
 *   npm run drive -- --url https://slackbot.workers.dev "hello"
 *   npm run drive -- --thread demo --stop                # archive the sandbox
 */
import { loadDevVars, requireVar } from "./env.ts";

const vars = loadDevVars();
const argv = process.argv.slice(2);

function flag(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, value && !value.startsWith("--") ? 2 : 1);
  return value && !value.startsWith("--") ? value : "true";
}

const stop = flag("stop") === "true";
const thread = flag("thread") ?? `cli-${Math.random().toString(36).slice(2, 8)}`;
const base = (flag("url") ?? process.env.WORKER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = requireVar("API_TOKEN", vars);
const text = argv.join(" ").trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${body.slice(0, 400)}`);
  return (body ? JSON.parse(body) : {}) as T;
}

interface Msg {
  ts: string;
  text: string;
  bot?: boolean;
}

async function main() {
  if (stop) {
    console.log(await api(`/threads/${thread}`, { method: "DELETE" }));
    return;
  }
  if (!text) {
    console.error('Usage: npm run drive -- [--thread id] [--url origin] "your message"');
    process.exit(2);
  }

  console.log(`thread: ${thread}\n> ${text}\n`);
  const seenBefore = ((await api<{ messages: Msg[] }>(`/threads/${thread}/messages`)).messages ?? [])
    .length;

  const queued = await api(`/threads/${thread}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text, user: "cli", userName: process.env.USER ?? "cli" }),
  });
  console.log(queued);

  let shown = seenBefore;
  let lastPhase = "";
  // Track text too: the status message is edited in place, and the watchdog fallback
  // lands there rather than as a new message.
  const seenText = new Map<string, string>();
  const deadline = Date.now() + 15 * 60_000;

  while (Date.now() < deadline) {
    const state = await api<{ phase: string; boxId?: string; prompt: unknown; lastError?: string }>(
      `/threads/${thread}`,
    );
    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      console.error(`  [${state.phase}${state.boxId ? ` ${state.boxId}` : ""}]`);
    }

    const { messages } = await api<{ messages: Msg[] }>(`/threads/${thread}/messages`);
    for (const [i, m] of messages.entries()) {
      const isNew = i >= shown;
      const edited = !isNew && seenText.get(m.ts) !== undefined && seenText.get(m.ts) !== m.text;
      if (isNew || edited) console.log(`\n${edited ? "(edited) " : ""}${m.text}`);
      seenText.set(m.ts, m.text);
    }
    shown = messages.length;

    if (state.lastError) {
      console.error(`\nerror: ${state.lastError}`);
      process.exitCode = 1;
      return;
    }
    if (state.phase === "idle" && !state.prompt) {
      console.log(`\n(done — reuse with: npm run drive -- --thread ${thread} "…")`);
      return;
    }
    await sleep(2000);
  }
  console.error("timed out");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
