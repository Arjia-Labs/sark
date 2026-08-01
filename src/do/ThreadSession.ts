import { DurableObject } from "cloudflare:workers";

import { mintThreadToken, THREAD_TOKEN_MAX_AGE_SECONDS } from "../auth/token.ts";
import { bootstrapMcp, verifyMcp } from "../box/bootstrap.ts";
import {
  BoxApiError,
  BoxClient,
  PENDING_STATES,
  USABLE_STATES,
  type BoxState,
  type PromptStatus,
} from "../box/client.ts";
import { MAX_PROMPT_CHARS, MAX_QUEUED_PROMPTS, num, type Env } from "../config.ts";
import { callTool } from "../mcp/tools.ts";
import { buildPrompt } from "../prompt.ts";
import { SlackClient, SlackTransport } from "../slack/api.ts";
import {
  effortPickerBlocks,
  statusBlocks,
  type ControlAction,
  type StatusPhase,
} from "../slack/controls.ts";
import { slackThreadId } from "../slack/events.ts";
import { MemoryTransport, type ThreadMessage, type Transport } from "../transport.ts";

const BOX_POLL_MS = 2_000;
const WATCHDOG_MS = 5_000;
const BOX_READY_TIMEOUT_MS = 180_000;

/**
 * Re-register MCP once a token is half-way to expiry, so a long-lived thread rotates
 * its credential instead of hitting the hard expiry mid-run.
 */
const TOKEN_REFRESH_MS = (THREAD_TOKEN_MAX_AGE_SECONDS / 2) * 1000;

/** Re-exported so existing importers keep working; defined in ../config.ts. */
export { MAX_PROMPT_CHARS, MAX_QUEUED_PROMPTS };

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[truncated at ${max} characters]`;
}

/** An error whose text was written for a user to read. */
class SessionError extends Error {
  constructor(
    message: string,
    readonly publicMessage: string = message,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

/**
 * What a user is allowed to see about a failure. Anything not explicitly written for
 * them gets a generic line: upstream error bodies and sandbox stderr can carry internal
 * identifiers, and sandbox output is not something we control at all.
 */
function publicError(err: unknown): string {
  if (err instanceof SessionError) return err.publicMessage;
  if (err instanceof BoxApiError) return err.publicMessage;
  return "Something went wrong handling this thread. The details are in the Worker logs.";
}

export interface SlackCoords {
  team?: string;
  teamName?: string;
  channel: string;
  channelName?: string;
  threadTs: string;
  triggerTs?: string;
}

export interface PromptRequest {
  /**
   * The name this Durable Object was addressed by. Passed in explicitly: `ctx.id.name`
   * is not populated, and the MCP callback resolves the object by this exact string,
   * so it has to round-trip through the token unchanged.
   */
  threadId: string;
  text: string;
  user?: string;
  userName?: string;
  transport?: "slack" | "memory";
  slack?: SlackCoords;
  metadata?: Record<string, unknown>;
  permalink?: string;
  timestamp?: string;
  /** Slack `event_id`, used to drop duplicate deliveries. */
  eventId?: string;
}

interface SessionState {
  threadId: string;
  transportKind: "slack" | "memory";
  slack?: SlackCoords;
  boxId?: string;
  boxState?: BoxState;
  boxRequestedAt?: number;
  mcpBoxId?: string;
  /** When the token behind the current MCP registration was minted. */
  mcpTokenAt?: number;
  createdAt: number;
  lastActivityAt: number;
  statusTs?: string;
  lastError?: string;
  /** The exact prompt last sent to the box, so ♻️ and 🧠 can re-run it verbatim. */
  lastPrompt?: { text: string; model?: string; effort?: string };
  /**
   * Set on a session seeded by a fork. The forked filesystem still carries the parent's
   * MCP registration, so the box is bootstrapped as soon as it is ready rather than
   * waiting for someone to speak - see `forkToNewThread`.
   */
  pendingBootstrap?: boolean;
  /** Thread this session was forked from, for context in the new thread. */
  forkedFrom?: string;
}

/** A re-run request parked for the state machine to pick up once the box is usable. */
interface RetryRequest {
  text: string;
  effort?: string;
}

interface RunState {
  promptId: string;
  startedAt: number;
  status: PromptStatus;
  agentPosts: number;
  warnedSlow?: boolean;
}

interface QueuedPrompt extends PromptRequest {
  receivedAt: number;
}

type Phase = "idle" | "starting_box" | "waiting_box" | "bootstrapping" | "running";

export class ThreadSession extends DurableObject<Env> {
  private box: BoxClient;
  private advancing: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.box = new BoxClient(env.BOX_API_KEY, env.BOX_BASE_URL);
  }

  // --- storage helpers -----------------------------------------------------

  private async session(): Promise<SessionState | undefined> {
    return this.ctx.storage.get<SessionState>("session");
  }

  private async putSession(s: SessionState): Promise<void> {
    await this.ctx.storage.put("session", s);
  }

  private async run(): Promise<RunState | undefined> {
    return this.ctx.storage.get<RunState>("run");
  }

  private async queue(): Promise<QueuedPrompt[]> {
    return (await this.ctx.storage.get<QueuedPrompt[]>("queue")) ?? [];
  }

  private messageLog() {
    return {
      read: async () => (await this.ctx.storage.get<ThreadMessage[]>("messages")) ?? [],
      write: async (m: ThreadMessage[]) => {
        await this.ctx.storage.put("messages", m);
      },
    };
  }

  private transport(s: SessionState): Transport {
    if (s.transportKind === "slack" && this.env.SLACK_BOT_TOKEN && s.slack) {
      return new SlackTransport(this.env.SLACK_BOT_TOKEN, {
        channel: s.slack.channel,
        threadTs: s.slack.threadTs,
        triggerTs: s.slack.triggerTs,
      });
    }
    return new MemoryTransport(this.messageLog());
  }

  /**
   * Post/replace the single status message that tracks this run, carrying the controls
   * that make sense for the current phase. Buttons rather than seeded reactions: they
   * are labelled, they leave no permanent counters on a finished message, and they can
   * disappear once they stop meaning anything.
   */
  private async status(
    s: SessionState,
    text: string,
    phase: StatusPhase = "done",
  ): Promise<void> {
    const transport = this.transport(s);
    // Blocks are a Slack construct; MemoryTransport records the text and ignores them.
    const message =
      transport.kind === "slack" ? { text, blocks: statusBlocks(text, phase) } : { text };
    try {
      if (s.statusTs) {
        await transport.updateMessage(s.statusTs, message);
      } else {
        const { ts } = await transport.postMessage(message);
        s.statusTs = ts;
        await this.putSession(s);
      }
    } catch (err) {
      console.error("status message failed", (err as Error).message);
    }
  }

  // --- public surface (called by the Worker) -------------------------------

  /** Slack retries deliveries; the retry lands on this same object, so dedupe here. */
  private async alreadySeen(eventId?: string): Promise<boolean> {
    if (!eventId) return false;
    const seen = (await this.ctx.storage.get<string[]>("seenEvents")) ?? [];
    if (seen.includes(eventId)) return true;
    seen.push(eventId);
    await this.ctx.storage.put("seenEvents", seen.slice(-100));
    return false;
  }

  async enqueue(
    req: PromptRequest,
  ): Promise<{
    threadId: string;
    boxId?: string;
    queued: number;
    duplicate?: boolean;
    rejected?: string;
  }> {
    const threadId = req.threadId;
    if (await this.alreadySeen(req.eventId)) {
      console.log(JSON.stringify({ at: "enqueue.duplicate", threadId, eventId: req.eventId }));
      return { threadId, boxId: (await this.session())?.boxId, queued: 0, duplicate: true };
    }
    console.log(JSON.stringify({ at: "enqueue.accept", threadId, eventId: req.eventId }));
    let s = await this.session();
    if (!s) {
      s = {
        threadId,
        transportKind: req.transport ?? (req.slack ? "slack" : "memory"),
        slack: req.slack,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
    }
    // A later mention can carry fresher Slack coordinates (e.g. a new trigger ts).
    if (req.slack) s.slack = { ...s.slack, ...req.slack };
    if (req.transport) s.transportKind = req.transport;
    s.lastActivityAt = Date.now();
    s.lastError = undefined;
    await this.putSession(s);

    const queue = await this.queue();
    if (queue.length >= MAX_QUEUED_PROMPTS) {
      // Backpressure: the agent is already behind, and an unbounded queue only means a
      // longer prompt and a bigger pile of work nobody is waiting for any more.
      const reason = `Too many messages are already queued on this thread (${queue.length}). Wait for the current run to finish.`;
      await this.say(s, `🚫 ${reason}`);
      return { threadId, boxId: s.boxId, queued: queue.length, rejected: reason };
    }
    queue.push({
      ...req,
      text: truncate(req.text, MAX_PROMPT_CHARS),
      receivedAt: Date.now(),
    });
    await this.ctx.storage.put("queue", queue);

    // Drive the box work from an alarm, not inline. The alarm is persisted in storage,
    // so even if this request is interrupted (a deploy resets the DO, an error mid-step),
    // the queued work is still picked up. Doing the fork/bootstrap inline here would strand
    // the queue with no alarm scheduled if it failed partway.
    await this.ensureAlarm(0);
    return { threadId, boxId: s.boxId, queued: queue.length };
  }

  /**
   * Guarantee the state machine keeps running: schedule an alarm unless one is already
   * pending. Every place that has outstanding work calls this, so a thread can never be
   * left with a non-empty queue / active run and no alarm to drive it.
   */
  private async ensureAlarm(ms: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    const at = Date.now() + ms;
    // Replace only if nothing is scheduled, or our target is meaningfully sooner.
    if (existing === null || at < existing - 250) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /** Tell the user why nothing happened, without creating a box for them. */
  async notifyRejected(req: PromptRequest, reason: string): Promise<void> {
    if (await this.alreadySeen(req.eventId)) return;
    const s: SessionState = (await this.session()) ?? {
      threadId: req.threadId,
      transportKind: req.transport ?? (req.slack ? "slack" : "memory"),
      slack: req.slack,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    try {
      await this.transport(s).postMessage({ text: `🚫 ${reason}` });
    } catch (err) {
      console.error("rejection notice failed", (err as Error).message);
    }
  }

  async state(): Promise<Record<string, unknown>> {
    // Reading state also re-arms a stranded thread, so pollers heal it for free.
    await this.ensureLiveness();
    const s = await this.session();
    const r = await this.run();
    const queue = await this.queue();
    return {
      threadId: s?.threadId,
      exists: Boolean(s),
      transport: s?.transportKind,
      boxId: s?.boxId,
      boxState: s?.boxState,
      mcpRegistered: Boolean(s?.mcpBoxId && s.mcpBoxId === s.boxId),
      phase: await this.phase(),
      prompt: r
        ? {
            promptId: r.promptId,
            status: r.status,
            agentPosts: r.agentPosts,
            elapsedSeconds: Math.round((Date.now() - r.startedAt) / 1000),
          }
        : null,
      queued: queue.length,
      lastError: s?.lastError,
      lastActivityAt: s?.lastActivityAt,
      messageCount: (await this.messageLog().read()).length,
    };
  }

  private async phase(): Promise<Phase> {
    const s = await this.session();
    const r = await this.run();
    if (r) return "running";
    if (!(await this.queue()).length) return "idle";
    if (!s?.boxId) return "starting_box";
    if (!USABLE_STATES.includes(s.boxState ?? "init")) return "waiting_box";
    return "bootstrapping";
  }

  /** `after` is a sequence number (see `ThreadMessage.seq`), not an array index. */
  async messages(after = 0): Promise<ThreadMessage[]> {
    const all = await this.messageLog().read();
    if (!after) return all;
    return all.filter((m) => (m.seq ?? 0) > after);
  }

  async boxEvents(cursor?: string, type?: string): Promise<unknown> {
    const s = await this.session();
    if (!s?.boxId) return { events: [], pageInfo: null };
    return this.box.events(s.boxId, { cursor, sort: "asc", limit: 200, type });
  }

  /**
   * Stop whatever is running. `notify` posts the outcome into the thread, which is what
   * a user typing "stop" needs - otherwise a stop with nothing to stop is silence.
   */
  async interrupt(opts: { notify?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
    const s = await this.session();
    if (!s?.boxId) {
      if (opts.notify && s) await this.say(s, "🛑 Nothing is running on this thread.");
      return { ok: false, detail: "no box for this thread" };
    }
    try {
      await this.box.interrupt(s.boxId);
    } catch (err) {
      console.error("interrupt failed", (err as Error).stack ?? (err as Error).message);
      if (opts.notify) await this.say(s, `⚠️ ${publicError(err)}`);
      return { ok: false, detail: (err as Error).message };
    }
    await this.ctx.storage.delete("run");
    await this.ctx.storage.put("queue", []);
    await this.status(s, "🛑 Interrupted.");
    // The interrupt notice is final for this run: hand the next run a fresh status
    // message instead of letting it overwrite this one.
    s.statusTs = undefined;
    await this.putSession(s);
    return { ok: true, detail: "interrupted" };
  }

  // --- reaction / block-kit controls ---------------------------------------

  /**
   * Run a control action triggered from Slack (an emoji reaction, or a Block Kit
   * selection). The caller has already verified the signature and applied the allowlist;
   * this only decides what the action means for the session.
   */
  async control(
    action: ControlAction,
    ctx: { actor?: string; eventId?: string } = {},
  ): Promise<{ ok: boolean; detail: string }> {
    if (await this.alreadySeen(ctx.eventId)) return { ok: false, detail: "duplicate" };

    const s = await this.session();
    // Fail closed: a reaction on a thread we know nothing about creates nothing.
    if (!s) return { ok: false, detail: "no session for this thread" };

    s.lastActivityAt = Date.now();
    await this.putSession(s);

    console.log(JSON.stringify({ at: "control", threadId: s.threadId, action, actor: ctx.actor }));

    try {
      switch (action) {
        case "interrupt":
          return await this.interrupt({ notify: true });
        case "archive":
          return await this.archiveNow(s);
        case "retry":
          return await this.parkRetry(s, s.lastPrompt?.effort, ctx.actor);
        case "escalate":
          return await this.offerEffort(s);
        case "desktop":
          return await this.showDesktop(s);
        case "fork":
          return await this.forkToNewThread(s, ctx.actor);
      }
    } catch (err) {
      console.error("control failed", (err as Error).stack ?? (err as Error).message);
      await this.say(s, `⚠️ ${publicError(err)}`);
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** 💤 — archive the sandbox now instead of waiting out the idle timer. */
  private async archiveNow(s: SessionState): Promise<{ ok: boolean; detail: string }> {
    if (!s.boxId) {
      await this.say(s, "💤 There is no sandbox on this thread to archive.");
      return { ok: false, detail: "no box" };
    }
    if (await this.run()) await this.interrupt({ notify: false });
    if (s.boxState === "archived" || s.boxState === "archiving") {
      await this.say(s, "💤 The sandbox is already archived.");
      return { ok: true, detail: "already archived" };
    }
    await this.box.stop(s.boxId);
    s.boxState = "archiving";
    s.mcpBoxId = undefined;
    await this.putSession(s);
    await this.say(
      s,
      "💤 Sandbox archived. The next message here wakes it up on the same filesystem.",
    );
    return { ok: true, detail: "archived" };
  }

  /**
   * ♻️ / 🧠 — park a re-run of the last prompt. Parked rather than sent directly so it
   * goes through the same ensureBox/ensureMcp path as any other work: the box may be
   * archived, and waking it is the state machine's job.
   */
  private async parkRetry(
    s: SessionState,
    effort?: string,
    actor?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    if (!s.lastPrompt) {
      await this.say(s, "♻️ There is nothing to re-run on this thread yet.");
      return { ok: false, detail: "no previous prompt" };
    }
    if (await this.run()) {
      await this.say(s, "♻️ Something is already running here. Stop it with 🛑 first.");
      return { ok: false, detail: "busy" };
    }
    await this.ctx.storage.put("retry", { text: s.lastPrompt.text, effort } satisfies RetryRequest);
    const who = actor ? ` for <@${actor}>` : "";
    const at = effort ? ` at \`${effort}\` effort` : "";
    await this.say(s, `♻️ Re-running the last prompt${at}${who}…`);
    await this.ensureAlarm(0);
    return { ok: true, detail: effort ?? "same effort" };
  }

  /** Called by /slack/interactive when someone picks a level from the 🧠 dropdown. */
  async retryWithEffort(effort: string, actor?: string): Promise<{ ok: boolean; detail: string }> {
    const s = await this.session();
    if (!s) return { ok: false, detail: "no session for this thread" };
    return this.parkRetry(s, effort, actor);
  }

  /**
   * 🧠 — offer the effort picker. A reaction can only ever mean one fixed thing, so the
   * actual choice is a Block Kit select; picking a level comes back through
   * /slack/interactive.
   */
  private async offerEffort(s: SessionState): Promise<{ ok: boolean; detail: string }> {
    if (!s.lastPrompt) {
      await this.say(s, "🧠 There is nothing to re-run on this thread yet.");
      return { ok: false, detail: "no previous prompt" };
    }
    const current = s.lastPrompt.effort ? ` Currently \`${s.lastPrompt.effort}\`.` : "";
    try {
      await this.transport(s).postMessage({
        text: "Pick a reasoning effort to re-run the last prompt at.",
        blocks: effortPickerBlocks(
          `🧠 Re-run the last prompt at a different reasoning effort.${current}`,
        ),
      });
    } catch (err) {
      console.error("effort picker failed", (err as Error).message);
      return { ok: false, detail: (err as Error).message };
    }
    return { ok: true, detail: "offered" };
  }

  /** 🖥️ — hand back a viewer for the sandbox's desktop. */
  private async showDesktop(s: SessionState): Promise<{ ok: boolean; detail: string }> {
    if (!s.boxId) {
      await this.say(s, "🖥️ There is no sandbox on this thread yet.");
      return { ok: false, detail: "no box" };
    }
    const d = await this.box.desktop(s.boxId, { publicAccess: true });
    if (!d.url) {
      await this.say(s, "🖥️ The sandbox did not return a desktop URL.");
      return { ok: false, detail: "no url" };
    }
    await this.say(s, `🖥️ Watch this sandbox: ${d.url}\n_Anyone with this link can view it._`);
    return { ok: true, detail: "desktop" };
  }

  /**
   * 🍴 — branch this conversation. Opens a new top-level thread in the same channel and
   * gives it a fork of this thread's box, so it starts from the current filesystem
   * without disturbing this one.
   *
   * The new thread is opened FIRST: its ts is the thread id the forked box needs baked
   * into its env, and box env is fixed at fork time.
   */
  private async forkToNewThread(
    s: SessionState,
    actor?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    if (!s.boxId) {
      await this.say(s, "🍴 There is no sandbox on this thread to fork.");
      return { ok: false, detail: "no box" };
    }
    if (s.transportKind !== "slack" || !s.slack || !this.env.SLACK_BOT_TOKEN) {
      await this.say(s, "🍴 Forking needs Slack; this thread has no channel to fork into.");
      return { ok: false, detail: "not a slack thread" };
    }

    const client = new SlackClient(this.env.SLACK_BOT_TOKEN);
    const channel = s.slack.channel;
    const team = s.slack.team ?? "";

    const head = await client.postToChannel(
      channel,
      actor
        ? `🍴 <@${actor}> forked a sandbox into this thread. It starts from that conversation's filesystem — mention me here to carry on.`
        : "🍴 Forked sandbox. Mention me here to carry on.",
    );
    const newThreadId = slackThreadId(team, channel, head.ts);
    const newSlack: SlackCoords = {
      team: s.slack.team,
      teamName: s.slack.teamName,
      channel,
      channelName: s.slack.channelName,
      threadTs: head.ts,
    };

    const forked = await this.box.fork(s.boxId, { env: this.envFor(newThreadId, newSlack) });

    try {
      await this.box.update(forked.id, {
        ttlSeconds: num(this.env.BOX_TTL_SECONDS, 3600),
        name: `slack ${newThreadId}`.slice(0, 120),
      });
    } catch (err) {
      console.error("fork update failed", (err as Error).message);
    }

    const stub = this.env.THREAD_SESSIONS.get(
      this.env.THREAD_SESSIONS.idFromName(newThreadId),
    ) as DurableObjectStub<ThreadSession>;
    await stub.adoptFork({
      threadId: newThreadId,
      boxId: forked.id,
      slack: newSlack,
      forkedFrom: s.threadId,
    });

    const link = await client.permalink(channel, head.ts);
    await this.say(s, `🍴 Forked into a new thread${link ? `: ${link}` : ""} · \`${forked.id}\``);
    return { ok: true, detail: newThreadId };
  }

  /**
   * Seed a brand-new session with an already-forked box. Never clobbers a live session:
   * the new thread's ts is fresh, so an existing session here would mean something has
   * gone badly wrong and overwriting it would strand a running box.
   */
  async adoptFork(input: {
    threadId: string;
    boxId: string;
    slack: SlackCoords;
    forkedFrom?: string;
  }): Promise<{ ok: boolean }> {
    if (await this.session()) return { ok: false };
    await this.putSession({
      threadId: input.threadId,
      transportKind: "slack",
      slack: input.slack,
      boxId: input.boxId,
      boxState: "provisioning",
      boxRequestedAt: Date.now(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      pendingBootstrap: true,
      forkedFrom: input.forkedFrom,
    });
    await this.ensureAlarm(0);
    return { ok: true };
  }

  /** One-off message that is not the tracked status message. */
  private async say(s: SessionState, text: string): Promise<void> {
    try {
      await this.transport(s).postMessage({ text });
    } catch (err) {
      console.error("notice failed", (err as Error).message);
    }
  }

  async dispose(): Promise<{ ok: boolean; boxId?: string }> {
    const s = await this.session();
    const boxId = s?.boxId;
    if (boxId) {
      try {
        await this.box.stop(boxId);
      } catch (err) {
        console.error("stop failed", (err as Error).message);
      }
    }
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return { ok: true, boxId };
  }

  /**
   * Invoked by the MCP endpoint once the bearer token has been verified. `boxId` is the
   * box the token was minted for: a token from a previous box generation must not still
   * be able to speak for this thread, so it is checked against the box we have now.
   */
  async invokeTool(name: string, args: Record<string, unknown>, boxId: string) {
    const s = await this.session();
    if (!s) {
      return { content: [{ type: "text" as const, text: "This thread session no longer exists." }], isError: true };
    }
    if (s.boxId !== boxId) {
      console.warn(
        JSON.stringify({ at: "invokeTool.staleBox", threadId: s.threadId, tokenBox: boxId, currentBox: s.boxId }),
      );
      return {
        content: [
          { type: "text" as const, text: "This token belongs to a sandbox that is no longer attached to this thread." },
        ],
        isError: true,
      };
    }
    s.lastActivityAt = Date.now();
    await this.putSession(s);

    const result = await callTool(this.transport(s), name, args);

    // Record that the agent spoke, so the watchdog knows not to post a fallback.
    if (!result.isError && (name === "slack_post_message" || name === "slack_upload_file")) {
      const r = await this.run();
      if (r) {
        r.agentPosts += 1;
        await this.ctx.storage.put("run", r);
      }
    }
    return result;
  }

  // --- state machine -------------------------------------------------------

  async alarm(): Promise<void> {
    await this.advance();
    await this.ensureLiveness();
  }

  /**
   * Self-heal: if there is outstanding work (a running prompt or a queued message) but no
   * alarm is scheduled to drive it, schedule one. Covers the case where a step was
   * interrupted (deploy reset, transient throw) before it could set its own next alarm.
   */
  private async ensureLiveness(): Promise<void> {
    const hasWork = Boolean(await this.run()) || (await this.queue()).length > 0;
    if (hasWork && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    }
  }

  private async advance(): Promise<void> {
    // Serialize: an alarm and an inbound request can both land here.
    if (this.advancing) return this.advancing;
    this.advancing = this.step().finally(() => {
      this.advancing = null;
    });
    return this.advancing;
  }

  private async wake(ms: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }

  private async step(): Promise<void> {
    const s = await this.session();
    if (!s) return;

    try {
      const active = await this.run();
      if (active) {
        await this.watchdog(s, active);
        return;
      }

      const queue = await this.queue();
      const retry = await this.ctx.storage.get<RetryRequest>("retry");

      if (!queue.length && !retry) {
        if (s.pendingBootstrap) {
          // A forked box inherits the parent's MCP registration. Re-register as soon as
          // it is usable instead of waiting for a mention, so the window in which the
          // fork holds its parent's credential is as short as we can make it.
          if (!(await this.ensureBox(s))) return;
          if (!(await this.ensureMcp(s))) return;
          s.pendingBootstrap = false;
          await this.putSession(s);
          await this.wake(num(this.env.IDLE_STOP_SECONDS, 900) * 1000);
          return;
        }
        await this.maybeStopIdle(s);
        return;
      }

      if (!(await this.ensureBox(s))) return; // still provisioning; alarm is set
      if (!(await this.ensureMcp(s))) return;

      if (retry) {
        await this.ctx.storage.delete("retry");
        const label = retry.effort ? ` at \`${retry.effort}\` effort` : "";
        await this.submit(s, retry.text, {
          effort: retry.effort,
          note: `♻️ Re-running${label}… \`${s.boxId}\``,
        });
        return;
      }

      await this.startPrompt(s);
    } catch (err) {
      await this.fail(s, err as Error);
    }
  }

  /** Returns true when the box is usable right now. */
  private async ensureBox(s: SessionState): Promise<boolean> {
    const ttl = num(this.env.BOX_TTL_SECONDS, 3600);

    if (!s.boxId) {
      await this.status(s, "⚙️ Starting a sandbox…", "working");
      const template = (this.env.TEMPLATE_BOX_ID ?? "").trim();
      const env = this.envFor(s.threadId, s.slack);
      const created = template
        ? await this.box.fork(template, { env })
        : await this.box.create({ ttlSeconds: ttl, env });
      s.boxId = created.id;
      s.boxState = created.state ?? "provisioning";
      s.boxRequestedAt = Date.now();
      s.mcpBoxId = undefined;
      await this.putSession(s);
      if (template) {
        // fork() does not accept ttlSeconds; set it (and a useful name) after the fact.
        try {
          await this.box.update(created.id, { ttlSeconds: ttl, name: `slack ${s.threadId}`.slice(0, 120) });
        } catch (err) {
          console.error("box update failed", (err as Error).message);
        }
      }
    }

    const info = await this.box.get(s.boxId!);
    s.boxState = info.state;
    await this.putSession(s);

    if (USABLE_STATES.includes(info.state)) return true;

    if (info.state === "archived") {
      // The box was stopped (idle timeout or TTL). Resume it onto the same filesystem
      // and re-register MCP with a freshly minted token.
      await this.status(s, "⚙️ Waking the sandbox back up…", "working");
      await this.box.resume(s.boxId!);
      s.mcpBoxId = undefined;
      s.boxRequestedAt = Date.now();
      await this.putSession(s);
      await this.wake(BOX_POLL_MS);
      return false;
    }

    if (info.state === "error") {
      throw new SessionError(
        `Sandbox entered an error state (${s.boxId}).`,
        "The sandbox entered an error state.",
      );
    }

    if (PENDING_STATES.includes(info.state) || info.state === "archiving") {
      const waited = Date.now() - (s.boxRequestedAt ?? Date.now());
      if (waited > BOX_READY_TIMEOUT_MS) {
        throw new SessionError(
          `Sandbox was still "${info.state}" after ${Math.round(waited / 1000)}s (${s.boxId}).`,
          `The sandbox was still "${info.state}" after ${Math.round(waited / 1000)}s.`,
        );
      }
      await this.wake(BOX_POLL_MS);
      return false;
    }

    await this.wake(BOX_POLL_MS);
    return false;
  }

  /**
   * Env baked into the box at fork time. Note the MCP token is NOT here: box env is
   * fixed for the life of the box, so a token placed in it could never expire or rotate.
   * `ensureMcp` hands the token over per registration instead.
   */
  private envFor(threadId: string, slack?: SlackCoords): Record<string, string> {
    const env: Record<string, string> = {
      SLACK_MCP_URL: `${this.env.PUBLIC_URL.replace(/\/$/, "")}/mcp`,
      SLACK_THREAD_ID: threadId,
    };
    if (slack) {
      env.SLACK_CHANNEL = slack.channel;
      env.SLACK_THREAD_TS = slack.threadTs;
      if (slack.team) env.SLACK_TEAM = slack.team;
    }
    return env;
  }

  /** True when the registered token is old enough that it should be replaced. */
  private tokenIsStale(s: SessionState): boolean {
    return Date.now() - (s.mcpTokenAt ?? 0) > TOKEN_REFRESH_MS;
  }

  /**
   * Registers the MCP server in the box, once per box generation and again whenever the
   * token behind it is approaching expiry. Each registration gets a freshly minted token
   * bound to this thread AND this box id, so the credential a sandbox holds is only ever
   * usable from that sandbox's generation and only for a bounded time.
   */
  private async ensureMcp(s: SessionState): Promise<boolean> {
    if (s.mcpBoxId === s.boxId && !this.tokenIsStale(s)) return true;

    const mintedAt = Date.now();
    const token = await mintThreadToken(this.env.MCP_TOKEN_SECRET, s.threadId, s.boxId!, mintedAt);

    const boot = await bootstrapMcp(this.box, s.boxId!, token);
    if (!boot.ok) {
      // boot.detail is sandbox output; log it, do not show it.
      throw new SessionError(
        `Could not wire the sandbox back to Slack: ${boot.detail}`,
        "Could not connect the sandbox back to Slack.",
      );
    }

    const health = await verifyMcp(this.box, s.boxId!);
    if (!health.ok) {
      // Not fatal: the agent may still connect on its own when the prompt runs.
      console.warn("mcp health check inconclusive:", health.detail);
    }

    s.mcpBoxId = s.boxId;
    s.mcpTokenAt = mintedAt;
    await this.putSession(s);
    return true;
  }

  private async startPrompt(s: SessionState): Promise<void> {
    // Drain the whole queue into one turn. Every message piled up on the SAME thread,
    // but each keeps its own sender and metadata so the agent can attribute correctly -
    // merging text alone would blame every request on whoever spoke first.
    const batch = await this.queue();
    if (!batch.length) return;
    await this.ctx.storage.put("queue", []);

    const history = s.transportKind === "slack" ? await this.threadHistory(s) : [];

    const prompt = buildPrompt({
      transportKind: s.transportKind,
      thread: {
        threadId: s.threadId,
        channel: s.slack?.channel,
        channelName: s.slack?.channelName,
        team: s.slack?.team,
        teamName: s.slack?.teamName,
        threadTs: s.slack?.threadTs,
      },
      messages: batch.map((q) => ({
        text: q.text,
        user: q.user,
        userName: q.userName,
        messageId: q.slack?.triggerTs ?? q.eventId,
        permalink: q.permalink,
        timestamp: q.timestamp ?? new Date().toISOString(),
        extra: q.metadata,
      })),
      history,
    });

    await this.submit(s, prompt);
  }

  /**
   * Send a prompt to the box and start watching it. Kept separate from `startPrompt` so
   * ♻️ and 🧠 can re-issue the stored prompt without rebuilding it from a queue that has
   * already been drained.
   */
  private async submit(
    s: SessionState,
    promptText: string,
    opts: { effort?: string; note?: string } = {},
  ): Promise<void> {
    const model = this.env.BOX_MODEL?.trim() || undefined;
    const queued = await this.box.prompt(s.boxId!, {
      provider: this.env.BOX_PROVIDER || "claude-code",
      prompt: promptText,
      model,
      reasoningEffort: opts.effort,
    });

    await this.ctx.storage.put("run", {
      promptId: queued.promptId,
      startedAt: Date.now(),
      status: queued.status ?? "queued",
      agentPosts: 0,
    } satisfies RunState);

    s.lastPrompt = { text: promptText, model, effort: opts.effort };
    await this.putSession(s);

    await this.status(s, opts.note ?? `🤖 Working… \`${s.boxId}\``, "working");
    try {
      await this.transport(s).addReaction("eyes");
    } catch {
      /* reactions are cosmetic */
    }
    await this.wake(WATCHDOG_MS);
  }

  private async threadHistory(s: SessionState): Promise<ThreadMessage[]> {
    try {
      const all = await this.transport(s).getThread(30);
      // Drop our own status message; it is noise to the model.
      return all.filter((m) => m.ts !== s.statusTs).slice(-20);
    } catch (err) {
      console.error("thread history failed", (err as Error).message);
      return [];
    }
  }

  /**
   * The agent is expected to reply through MCP. This makes sure the thread never
   * goes silent when it does not: on failure, or on a finish with nothing said,
   * we recover the answer from the box event log.
   */
  private async watchdog(s: SessionState, r: RunState): Promise<void> {
    const cap = num(this.env.PROMPT_HARD_CAP_SECONDS, 1200) * 1000;
    let run;
    try {
      run = await this.box.promptStatus(s.boxId!, r.promptId);
    } catch (err) {
      if (err instanceof BoxApiError && err.status === 404) {
        await this.finishRun(s, r, "The sandbox lost track of this run.");
        return;
      }
      throw err;
    }

    r.status = run.status;
    await this.ctx.storage.put("run", r);

    if (run.status === "failed") {
      await this.finishRun(s, r, "The agent run failed inside the sandbox.");
      return;
    }

    if (run.done || run.status === "finished") {
      const fallback = r.agentPosts === 0 ? await this.recoverReply(s, r) : null;
      await this.finishRun(s, r, fallback);
      return;
    }

    const elapsed = Date.now() - r.startedAt;
    if (elapsed > cap) {
      await this.finishRun(s, r, `Gave up waiting after ${Math.round(elapsed / 1000)}s.`);
      return;
    }
    if (elapsed > 90_000 && !r.warnedSlow) {
      r.warnedSlow = true;
      await this.ctx.storage.put("run", r);
      if (r.agentPosts === 0) await this.status(s, `🤖 Still working… \`${s.boxId}\``, "working");
    }
    await this.wake(WATCHDOG_MS);
  }

  /** Pull the agent's last real reply out of the box event log. */
  private async recoverReply(s: SessionState, r: RunState): Promise<string | null> {
    try {
      const page = await this.box.events(s.boxId!, { sort: "asc", limit: 200, type: "response" });
      const texts = page.events
        .filter((e) => e.taskId === r.promptId && !e.data?.is_streaming)
        .map((e) => String(e.data?.content ?? "").trim())
        .filter(Boolean);
      return texts.length ? (texts[texts.length - 1] as string) : null;
    } catch (err) {
      console.error("event recovery failed", (err as Error).message);
      return null;
    }
  }

  private async finishRun(s: SessionState, r: RunState, fallback: string | null): Promise<void> {
    await this.ctx.storage.delete("run");
    s.lastActivityAt = Date.now();
    await this.putSession(s);

    const seconds = Math.round((Date.now() - r.startedAt) / 1000);
    const transport = this.transport(s);

    if (fallback) {
      // The agent never spoke (or failed). Say something rather than go silent.
      await this.status(s, fallback);
      // Silence usually means the MCP registration is gone (a resumed snapshot, or the
      // agent removed it). Force a re-bootstrap so the next turn can talk again.
      s.mcpBoxId = undefined;
    } else if (s.statusTs) {
      await this.status(s, `✅ Done in ${seconds}s · \`${s.boxId}\``);
    }
    // The status message belongs to this run only.
    s.statusTs = undefined;
    await this.putSession(s);

    try {
      await transport.removeReaction("eyes");
      await transport.addReaction("white_check_mark");
    } catch {
      /* cosmetic */
    }

    await this.advanceOrIdle();
  }

  private async advanceOrIdle(): Promise<void> {
    if ((await this.queue()).length) {
      await this.wake(100);
    } else {
      await this.wake(num(this.env.IDLE_STOP_SECONDS, 900) * 1000);
    }
  }

  /** Archive the box after a quiet period; a later message resumes it. */
  private async maybeStopIdle(s: SessionState): Promise<void> {
    if (!s.boxId) return;
    const idleMs = num(this.env.IDLE_STOP_SECONDS, 900) * 1000;
    const quietFor = Date.now() - s.lastActivityAt;
    if (quietFor < idleMs) {
      await this.wake(idleMs - quietFor);
      return;
    }
    if (s.boxState === "archived" || s.boxState === "archiving") return;

    try {
      await this.box.stop(s.boxId);
      s.boxState = "archiving";
      s.mcpBoxId = undefined;
      await this.putSession(s);
    } catch (err) {
      console.error("idle stop failed", (err as Error).message);
    }
  }

  private async fail(s: SessionState, err: Error): Promise<void> {
    console.error("session error", err.stack ?? err.message);
    s.lastError = err.message;
    await this.putSession(s);
    await this.ctx.storage.delete("run");

    // Whatever was queued is not going to run. Say so rather than dropping it silently.
    const dropped = (await this.queue()).length;
    await this.ctx.storage.put("queue", []);
    const note = dropped ? ` ${dropped} queued message${dropped === 1 ? " was" : "s were"} dropped.` : "";

    await this.status(s, `⚠️ ${publicError(err)}${note}`);
    s.statusTs = undefined;
    await this.putSession(s);

    // A failed step consumed its alarm without scheduling the next one, which used to
    // leave the thread dormant with a live sandbox that `maybeStopIdle` never reached.
    await this.wake(num(this.env.IDLE_STOP_SECONDS, 900) * 1000);
  }
}
