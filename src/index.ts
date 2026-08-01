import { Hono } from "hono";

import { bearer, timingSafeEqual, verifyThreadToken } from "./auth/token.ts";
import { isAllowed, type Env } from "./config.ts";
import { MAX_PROMPT_CHARS, type PromptRequest, type ThreadSession } from "./do/ThreadSession.ts";
import { handleMcpRequest } from "./mcp/server.ts";
import { SlackClient } from "./slack/api.ts";
import { buttonAction, EFFORT_ACTION_ID, isEffort } from "./slack/controls.ts";
import {
  interpret,
  isInterruptCommand,
  slackThreadId,
  type SlackEventEnvelope,
} from "./slack/events.ts";
import { verifySlackSignature } from "./slack/verify.ts";

export { ThreadSession } from "./do/ThreadSession.ts";

type App = { Bindings: Env };

const app = new Hono<App>();

function session(env: Env, threadId: string): DurableObjectStub<ThreadSession> {
  return env.THREAD_SESSIONS.get(
    env.THREAD_SESSIONS.idFromName(threadId),
  ) as DurableObjectStub<ThreadSession>;
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    slack: Boolean(c.env.SLACK_BOT_TOKEN && c.env.SLACK_SIGNING_SECRET),
    template: c.env.TEMPLATE_BOX_ID || null,
    provider: c.env.BOX_PROVIDER,
  }),
);

// --- MCP: the box calling back ---------------------------------------------

app.all("/mcp", async (c) => {
  const token = bearer(c.req.raw);
  if (!token) return c.json({ error: "missing bearer token" }, 401);

  const payload = await verifyThreadToken(c.env.MCP_TOKEN_SECRET, token);
  if (!payload) return c.json({ error: "invalid or expired token" }, 401);

  // The thread AND the sandbox generation are fixed by the token; nothing in the request
  // body can change either.
  const stub = session(c.env, payload.tid);
  return handleMcpRequest(c.req.raw, (name, args) => stub.invokeTool(name, args, payload.bid));
});

// --- Slack-free control API -------------------------------------------------

/**
 * Everything under /api is gated on API_TOKEN alone and deliberately bypasses the Slack
 * allowlist: a caller can address any thread id and, by passing `slack` coordinates, make
 * the bot post into any conversation its token can reach. API_TOKEN is therefore
 * full-workspace bot authority — treat it like the bot token itself. The gate below runs
 * before every /api route, and fails closed when API_TOKEN is unset.
 */
const api = new Hono<App>();

api.use("*", async (c, next) => {
  const token = bearer(c.req.raw);
  if (!c.env.API_TOKEN) return c.json({ error: "API_TOKEN is not configured" }, 503);
  if (!token || !timingSafeEqual(token, c.env.API_TOKEN)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

api.post("/threads/:id/prompt", async (c) => {
  const threadId = c.req.param("id");
  const body = await c.req.json<Partial<PromptRequest>>().catch(() => ({}) as Partial<PromptRequest>);
  if (!body.text || !String(body.text).trim()) {
    return c.json({ error: "text is required" }, 400);
  }
  if (String(body.text).length > MAX_PROMPT_CHARS) {
    return c.json({ error: `text exceeds ${MAX_PROMPT_CHARS} characters` }, 413);
  }
  const result = await session(c.env, threadId).enqueue({
    threadId,
    text: String(body.text),
    user: body.user,
    userName: body.userName,
    transport: body.transport ?? (body.slack ? "slack" : "memory"),
    slack: body.slack,
    metadata: body.metadata,
    timestamp: body.timestamp ?? new Date().toISOString(),
  });
  // A full queue is backpressure, not acceptance.
  return c.json(result, result.rejected ? 429 : 202);
});

api.get("/threads/:id", async (c) => c.json(await session(c.env, c.req.param("id")).state()));

api.get("/threads/:id/messages", async (c) => {
  const after = Number(c.req.query("after") ?? 0);
  const messages = await session(c.env, c.req.param("id")).messages(
    Number.isFinite(after) ? after : 0,
  );
  return c.json({ messages, count: messages.length });
});

api.get("/threads/:id/events", async (c) =>
  c.json(
    (await session(c.env, c.req.param("id")).boxEvents(
      c.req.query("cursor") ?? undefined,
      c.req.query("type") ?? undefined,
    )) as Record<string, unknown>,
  ),
);

api.post("/threads/:id/interrupt", async (c) =>
  c.json(await session(c.env, c.req.param("id")).interrupt()),
);

api.delete("/threads/:id", async (c) => c.json(await session(c.env, c.req.param("id")).dispose()));

app.route("/api", api);

// --- Slack ------------------------------------------------------------------

app.post("/slack/events", async (c) => {
  if (!c.env.SLACK_SIGNING_SECRET) return c.json({ error: "slack is not configured" }, 503);

  const raw = await c.req.text();
  const verified = await verifySlackSignature(c.env.SLACK_SIGNING_SECRET, c.req.raw.headers, raw);
  if (!verified.ok) return c.json({ error: verified.reason }, 401);

  let envelope: SlackEventEnvelope;
  try {
    envelope = JSON.parse(raw) as SlackEventEnvelope;
  } catch {
    return c.json({ error: "bad json" }, 400);
  }

  if (envelope.type === "url_verification") return c.text(envelope.challenge ?? "");

  // Slack re-delivers an event (same event_id) if it doesn't get a 200 within 3s.
  // We ack fast, so a retry means the first ack was slow (usually a cold start). Drop
  // retries at the edge: reprocessing them is what produced duplicate sandbox runs.
  // event_id dedup in the DO is the backstop; this is the primary guard.
  const retryNum = c.req.header("x-slack-retry-num");
  console.log(
    JSON.stringify({
      at: "slack.event",
      event_id: envelope.event_id,
      type: envelope.event?.type,
      retry_num: retryNum ?? null,
      retry_reason: c.req.header("x-slack-retry-reason") ?? null,
    }),
  );
  if (retryNum) return c.body(null, 200);

  const decision = interpret(envelope);
  if (decision.kind === "ignore") return c.body(null, 200);

  const gate = isAllowed(c.env, {
    team: decision.team,
    channel: decision.channel,
    user: decision.user,
  });

  if (decision.kind === "control") {
    // A reaction payload has no thread_ts, so the thread has to be resolved with a Slack
    // call before we know which object to address. Silently drop a disallowed reaction:
    // unlike a mention, nobody is waiting on an answer, and replying would turn any
    // emoji in a public channel into a way to make the bot talk.
    if (!gate.ok || !c.env.SLACK_BOT_TOKEN) return c.body(null, 200);
    const token = c.env.SLACK_BOT_TOKEN;
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const threadTs = await new SlackClient(token).resolveThreadTs(
            decision.channel,
            decision.itemTs,
          );
          const threadId = slackThreadId(decision.team, decision.channel, threadTs);
          await session(c.env, threadId).control(decision.action, {
            actor: decision.user,
            eventId: decision.eventId,
          });
        } catch (err) {
          console.error("control handling failed", (err as Error).stack);
        }
      })(),
    );
    return c.body(null, 200);
  }

  // Slack needs a 200 within 3s; everything real happens after we have replied.
  c.executionCtx.waitUntil(
    (async () => {
      const stub = session(c.env, decision.threadId);
      try {
        if (!gate.ok) {
          await stub.notifyRejected(decision.request, gate.reason);
          return;
        }
        if (isInterruptCommand(decision.request.text)) {
          // notify: a user typed "stop" and is owed an answer either way.
          await stub.interrupt({ notify: true });
          return;
        }
        await stub.enqueue(decision.request);
      } catch (err) {
        console.error("slack event handling failed", (err as Error).stack);
      }
    })(),
  );

  return c.body(null, 200);
});

/**
 * Block Kit interactions. This exists only because 🧠 needs to offer a *choice* of
 * reasoning effort, which a reaction cannot express. It was previously removed for
 * running no allowlist check; the gate below is why it is safe to have back.
 */
app.post("/slack/interactive", async (c) => {
  if (!c.env.SLACK_SIGNING_SECRET) return c.json({ error: "slack is not configured" }, 503);

  const raw = await c.req.text();
  const verified = await verifySlackSignature(c.env.SLACK_SIGNING_SECRET, c.req.raw.headers, raw);
  if (!verified.ok) return c.json({ error: verified.reason }, 401);

  let payload: {
    type?: string;
    user?: { id?: string };
    team?: { id?: string };
    channel?: { id?: string };
    message?: { thread_ts?: string; ts?: string };
    trigger_id?: string;
    actions?: { action_id?: string; selected_option?: { value?: string } }[];
  };
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}");
  } catch {
    return c.json({ error: "bad payload" }, 400);
  }

  const action = payload.actions?.[0];
  const team = payload.team?.id;
  const channel = payload.channel?.id;
  const user = payload.user?.id;
  const threadTs = payload.message?.thread_ts ?? payload.message?.ts;
  if (payload.type !== "block_actions" || !action || !team || !channel || !user || !threadTs) {
    return c.body(null, 200);
  }

  // The same gate a mention goes through. Without it, anyone who can see the message
  // could drive the sandbox.
  if (!isAllowed(c.env, { team, channel, user }).ok) return c.body(null, 200);

  const threadId = slackThreadId(team, channel, threadTs);

  if (action.action_id === EFFORT_ACTION_ID) {
    const effort = action.selected_option?.value;
    if (!isEffort(effort)) return c.body(null, 200);
    c.executionCtx.waitUntil(
      session(c.env, threadId)
        .retryWithEffort(effort, user)
        .then(() => {})
        .catch((err: Error) => console.error("effort retry failed", err.stack)),
    );
    return c.body(null, 200);
  }

  // Status-message buttons. Slack has already shown the confirm dialog for the
  // destructive ones, so reaching here means the user went through with it.
  const control = buttonAction(action.action_id ?? "");
  if (control) {
    c.executionCtx.waitUntil(
      session(c.env, threadId)
        .control(control, { actor: user, eventId: payload.trigger_id })
        .then(() => {})
        .catch((err: Error) => console.error("button control failed", err.stack)),
    );
  }

  return c.body(null, 200);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  // The message can carry upstream response bodies and sandbox output; log it, don't ship it.
  console.error("unhandled", err.stack ?? err.message);
  return c.json({ error: "internal error" }, 500);
});

export default app;
