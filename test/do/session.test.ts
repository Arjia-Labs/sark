import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BoxState } from "../../src/box/client.ts";
import { MAX_PROMPT_CHARS, MAX_QUEUED_PROMPTS, type ThreadSession } from "../../src/do/ThreadSession.ts";
import type { ThreadMessage } from "../../src/transport.ts";

/**
 * Integration tests for the per-thread state machine, running the real Durable Object
 * inside workerd with real storage and real alarms. The only thing faked is the outside
 * world: a stub `fetch` stands in for the Box API, and threads use `transport: "memory"`
 * so everything the session says lands in the DO's own message log.
 */

// --- fake Box API -----------------------------------------------------------

interface Knobs {
  /** State every `GET /boxes/{id}` reports. "provisioning" parks the machine. */
  boxState: BoxState;
  /** Non-200 makes `POST /boxes` fail with a BoxApiError carrying `errorBody`. */
  createStatus: number;
  /** Non-200 makes `GET /boxes/{id}` fail the same way. */
  getStatus: number;
  errorBody: string;
  promptStatus: string;
  promptDone: boolean;
  /** `type=response` events, used by the silent-agent recovery path. */
  events: Array<{ type: string; taskId?: string; data?: Record<string, unknown> }>;
}

interface ApiCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

let knobs: Knobs;
let calls: ApiCall[];

function defaults(): Knobs {
  return {
    boxState: "ready",
    createStatus: 200,
    getStatus: 200,
    errorBody: "",
    promptStatus: "running",
    promptDone: false,
    events: [],
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function boxApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname.replace("/api/box/v1", "");
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  calls.push({ method, path, body });

  const box = { id: "box-1", name: "test", state: knobs.boxState };

  if (method === "POST" && path === "/boxes") {
    if (knobs.createStatus !== 200) return new Response(knobs.errorBody, { status: knobs.createStatus });
    return json({ box });
  }
  if (method === "GET" && path === "/boxes/box-1") {
    if (knobs.getStatus !== 200) return new Response(knobs.errorBody, { status: knobs.getStatus });
    return json({ box });
  }
  if (method === "PATCH" && path === "/boxes/box-1") return json({ box });
  if (method === "POST" && /\/boxes\/box-1\/(resume|stop|interrupt)$/.test(path)) {
    return json({ id: "box-1", status: "ok" });
  }
  if (method === "PUT" && path === "/boxes/box-1/files") {
    return json({ success: true, path: String(body?.path ?? ""), size: 0 });
  }
  if (method === "POST" && path === "/boxes/box-1/commands") {
    const command = String(body?.command ?? "");
    const stdout = command.includes("claude mcp list")
      ? "slack: https://worker/mcp (HTTP) - ✓ connected"
      : "BOOTSTRAP_OK";
    return json({ success: true, exitCode: 0, signal: null, stdout, stderr: "", timedOut: false });
  }
  if (method === "POST" && path === "/boxes/box-1/prompt") {
    return json({ promptId: "p1", status: "queued" });
  }
  if (method === "GET" && path === "/boxes/box-1/prompts/p1") {
    return json({
      promptRun: { id: "p1", promptId: "p1", boxId: "box-1", status: knobs.promptStatus, done: knobs.promptDone },
    });
  }
  if (method === "GET" && path === "/boxes/box-1/events") {
    return json({ events: knobs.events, pageInfo: { nextCursor: null, hasMore: false, limit: 200 } });
  }
  throw new Error(`unexpected Box API call: ${method} ${path}`);
}

beforeAll(() => {
  // Installed once, for the whole isolate: an alarm can still fire after the test that
  // scheduled it has finished, and none of those may reach the real ascii.dev.
  globalThis.fetch = boxApi as typeof fetch;
});

beforeEach(() => {
  knobs = defaults();
  calls = [];
});

// --- harness ----------------------------------------------------------------

type Stub = DurableObjectStub<ThreadSession>;

let counter = 0;
let live: Stub[] = [];

function newThread(): { id: string; stub: Stub } {
  const id = `T1/C1/thread-${counter++}`;
  const ns = env.THREAD_SESSIONS as DurableObjectNamespace<ThreadSession>;
  const stub = ns.get(ns.idFromName(id)) as Stub;
  live.push(stub);
  return { id, stub };
}

afterEach(async () => {
  // A parked session keeps re-arming its alarm every couple of seconds. Storage is
  // shared across tests here, so wind each thread down rather than leave it polling the
  // fake Box API for the rest of the file.
  for (const stub of live) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  }
  live = [];
});

/** Alarms fire on their own in this runtime, so most waiting is condition-based. */
async function until(what: string, cond: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await scheduler.wait(10);
  }
}

/**
 * `state()` returns `Record<string, unknown>`, which the RPC type machinery narrows to
 * `never` at the call site. Re-widen it here rather than casting at every assertion.
 */
async function snapshot(stub: Stub): Promise<Record<string, any>> {
  return (await stub.state()) as unknown as Record<string, any>;
}

function storage<T>(stub: Stub, key: string): Promise<T | undefined> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get<T>(key));
}

function alarmAt(stub: Stub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

function seed(stub: Stub, entries: Record<string, unknown>): Promise<void> {
  return runInDurableObject(stub, async (_instance, state) => {
    for (const [k, v] of Object.entries(entries)) await state.storage.put(k, v);
  });
}

function baseSession(threadId: string, extra: Record<string, unknown> = {}) {
  return {
    threadId,
    transportKind: "memory",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...extra,
  };
}

const texts = (m: ThreadMessage[]) => m.map((x) => x.text);

// --- tests ------------------------------------------------------------------

describe("ThreadSession happy path", () => {
  it("takes a prompt from enqueue to a readable reply", async () => {
    const { id, stub } = newThread();

    const accepted = await stub.enqueue({ threadId: id, text: "what is 6 times 7?", transport: "memory" });
    expect(accepted).toMatchObject({ threadId: id, queued: 1 });

    // The alarm drives box creation, MCP bootstrap and the prompt call.
    await until("the prompt to start", async () => Boolean((await snapshot(stub)).prompt));

    const state = await snapshot(stub);
    expect(state.boxId).toBe("box-1");
    expect(state.mcpRegistered).toBe(true);
    expect(state.phase).toBe("running");

    // The user's text has to reach the sandbox, wrapped in the built prompt.
    const prompt = calls.find((c) => c.path === "/boxes/box-1/prompt");
    expect(String(prompt?.body?.prompt)).toContain("what is 6 times 7?");
    // The MCP token is handed over per registration, never baked into the box env.
    const create = calls.find((c) => c.method === "POST" && c.path === "/boxes");
    expect(JSON.stringify(create?.body)).not.toContain("MCP_TOKEN");

    // The agent answers the only way it can: back through MCP.
    const reply = await stub.invokeTool("slack_post_message", { text: "42" }, "box-1");
    expect(reply.isError).toBeFalsy();

    knobs.promptStatus = "finished";
    knobs.promptDone = true;
    await runDurableObjectAlarm(stub);
    await until("the run to finish", async () => (await snapshot(stub)).prompt === null);

    const messages = await stub.messages();
    expect(texts(messages)).toContain("42");
    // The agent spoke, so the status line closes with a success, not a fallback.
    expect(texts(messages).some((t) => t.startsWith("✅ Done in"))).toBe(true);
    expect(await snapshot(stub)).toMatchObject({ queued: 0, phase: "idle" });
  });

  it("recovers the answer from the box event log when the agent never speaks", async () => {
    const { id, stub } = newThread();
    knobs.events = [
      { type: "response", taskId: "p1", data: { content: "streaming fragment", is_streaming: true } },
      { type: "response", taskId: "p1", data: { content: "the real answer" } },
    ];

    await stub.enqueue({ threadId: id, text: "hello", transport: "memory" });
    await until("the prompt to start", async () => Boolean((await snapshot(stub)).prompt));

    knobs.promptStatus = "finished";
    knobs.promptDone = true;
    await runDurableObjectAlarm(stub);
    await until("the run to finish", async () => (await snapshot(stub)).prompt === null);

    // Silence is never acceptable: the thread gets the recovered reply, not nothing.
    expect(texts(await stub.messages())).toContain("the real answer");
  });
});

describe("enqueue guards", () => {
  it("queues a Slack event once even when it is delivered twice", async () => {
    const { id, stub } = newThread();
    knobs.boxState = "provisioning"; // park the machine so the queue stays observable

    const first = await stub.enqueue({ threadId: id, text: "hi", transport: "memory", eventId: "Ev01" });
    const second = await stub.enqueue({ threadId: id, text: "hi", transport: "memory", eventId: "Ev01" });

    expect(first).toMatchObject({ queued: 1 });
    expect(first.duplicate).toBeUndefined();
    expect(second).toMatchObject({ queued: 0, duplicate: true });
    expect((await storage<unknown[]>(stub, "queue"))?.length).toBe(1);
  });

  it("rejects prompts past the queue cap instead of piling them up", async () => {
    const { id, stub } = newThread();
    knobs.boxState = "provisioning";

    for (let i = 0; i < MAX_QUEUED_PROMPTS; i++) {
      const r = await stub.enqueue({ threadId: id, text: `msg ${i}`, transport: "memory" });
      expect(r.rejected).toBeUndefined();
    }
    const overflow = await stub.enqueue({ threadId: id, text: "one too many", transport: "memory" });

    expect(overflow.rejected).toMatch(/Too many messages/);
    expect(overflow.queued).toBe(MAX_QUEUED_PROMPTS);
    // Backpressure the user can see, not a silent drop.
    expect(texts(await stub.messages()).some((t) => t.startsWith("🚫"))).toBe(true);
    expect((await storage<unknown[]>(stub, "queue"))?.length).toBe(MAX_QUEUED_PROMPTS);
  });

  it("truncates an oversized prompt at the storage boundary", async () => {
    const { id, stub } = newThread();
    knobs.boxState = "provisioning";

    await stub.enqueue({ threadId: id, text: "x".repeat(MAX_PROMPT_CHARS * 2), transport: "memory" });

    const queue = (await storage<Array<{ text: string }>>(stub, "queue")) ?? [];
    const stored = queue[0]?.text ?? "";
    expect(stored.startsWith("x".repeat(MAX_PROMPT_CHARS))).toBe(true);
    expect(stored).toContain(`[truncated at ${MAX_PROMPT_CHARS} characters]`);
    // The whole 32k must not survive anywhere in the queue entry.
    expect(stored.length).toBeLessThan(MAX_PROMPT_CHARS * 1.1);
  });
});

describe("failure handling", () => {
  /** Get a session with a box and a full queue, then make the Box API start failing. */
  async function failAfterQueueing(stub: Stub, id: string, queued: number): Promise<void> {
    knobs.boxState = "provisioning";
    for (let i = 0; i < queued; i++) {
      await stub.enqueue({ threadId: id, text: `msg ${i}`, transport: "memory" });
    }
    await until("the box to exist", async () => Boolean((await snapshot(stub)).boxId));

    knobs.getStatus = 500;
    knobs.errorBody = '{"error":"db-7.internal refused the connection"}';
    await runDurableObjectAlarm(stub);
    await until("the failure to land", async () => Boolean((await snapshot(stub)).lastError));
  }

  it("leaves an alarm scheduled after a failed step", async () => {
    const { id, stub } = newThread();
    await failAfterQueueing(stub, id, 1);

    // Without this the thread goes dormant holding a live sandbox that `maybeStopIdle`
    // can never reach, because nothing is left to wake the object up.
    expect(await alarmAt(stub)).not.toBeNull();
  });

  it("reports the dropped queue without leaking upstream detail", async () => {
    const { id, stub } = newThread();
    await failAfterQueueing(stub, id, 3);

    const notice = texts(await stub.messages()).find((t) => t.startsWith("⚠️"));
    expect(notice).toBeDefined();
    expect(notice).toContain("The sandbox API returned an error (HTTP 500)");
    expect(notice).toContain("3 queued messages were dropped.");
    // The upstream body names internal infrastructure; it belongs in the logs only.
    expect(notice).not.toContain("db-7.internal");

    // The queue really is empty - the count above is not a lie.
    expect((await storage<unknown[]>(stub, "queue"))?.length ?? 0).toBe(0);
  });

  it("counts a single dropped message in the singular", async () => {
    const { id, stub } = newThread();
    await failAfterQueueing(stub, id, 1);
    expect(texts(await stub.messages()).find((t) => t.startsWith("⚠️"))).toContain(
      "1 queued message was dropped.",
    );
  });
});

describe("interrupt", () => {
  it("hands the next run a fresh status message", async () => {
    const { id, stub } = newThread();
    await stub.enqueue({ threadId: id, text: "long job", transport: "memory" });
    await until("the prompt to start", async () => Boolean((await snapshot(stub)).prompt));

    const beforeStop = await storage<{ statusTs?: string }>(stub, "session");
    expect(beforeStop?.statusTs).toBeTruthy();

    expect(await stub.interrupt()).toMatchObject({ ok: true });
    expect((await storage<{ statusTs?: string }>(stub, "session"))?.statusTs).toBeUndefined();

    const stoppedTs = beforeStop!.statusTs!;
    const interrupted = (await stub.messages()).find((m) => m.ts === stoppedTs);
    expect(interrupted?.text).toBe("🛑 Interrupted.");

    // The next run must post its own status line. If `statusTs` survived the interrupt,
    // this run would silently overwrite the "🛑 Interrupted." notice above.
    await stub.enqueue({ threadId: id, text: "next job", transport: "memory" });
    await until("the second prompt to start", async () => Boolean((await snapshot(stub)).prompt));

    const after = await stub.messages();
    expect(after.find((m) => m.ts === stoppedTs)?.text).toBe("🛑 Interrupted.");
    expect(after.some((m) => m.ts !== stoppedTs && m.text.startsWith("🤖 Working…"))).toBe(true);
  });

  it("answers a stop typed at a thread with nothing running", async () => {
    const { id, stub } = newThread();
    // A session exists (the thread has been used) but no sandbox is attached.
    await seed(stub, { session: baseSession(id) });

    const result = await stub.interrupt({ notify: true });

    expect(result).toMatchObject({ ok: false });
    // A user who typed "stop" is owed an answer either way; silence reads as a hang.
    expect(texts(await stub.messages())).toContain("🛑 Nothing is running on this thread.");
  });

  it("stays silent when no notify was asked for", async () => {
    const { id, stub } = newThread();
    await seed(stub, { session: baseSession(id) });

    expect(await stub.interrupt()).toMatchObject({ ok: false });
    expect(await stub.messages()).toHaveLength(0);
  });
});

describe("invokeTool", () => {
  it("refuses a token minted for a sandbox that is no longer the thread's", async () => {
    const { id, stub } = newThread();
    await seed(stub, { session: baseSession(id, { boxId: "box-1" }) });

    const stale = await stub.invokeTool("slack_post_message", { text: "from an old box" }, "box-0");

    expect(stale.isError).toBe(true);
    expect(stale.content[0]?.text).toContain("no longer attached to this thread");
    // Crucially, nothing was posted on the old box's behalf.
    expect(await stub.messages()).toHaveLength(0);

    const current = await stub.invokeTool("slack_post_message", { text: "from the current box" }, "box-1");
    expect(current.isError).toBeFalsy();
    expect(texts(await stub.messages())).toContain("from the current box");
  });

  it("reports a thread that no longer exists rather than throwing", async () => {
    const { stub } = newThread();
    const r = await stub.invokeTool("slack_post_message", { text: "hi" }, "box-1");
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("no longer exists");
  });
});

describe("messages cursor", () => {
  it("treats `after` as a sequence number, not an array index", async () => {
    const { id, stub } = newThread();
    // A log already at the 500-entry trim cap. Once it trims, array position and `seq`
    // permanently disagree, and an index-based cursor starts skipping or repeating.
    const seeded: ThreadMessage[] = Array.from({ length: 500 }, (_, i) => ({
      ts: `m${i + 1}`,
      text: `old ${i + 1}`,
      bot: true,
      seq: i + 1,
    }));
    await seed(stub, { session: baseSession(id, { boxId: "box-1" }), messages: seeded });

    for (let i = 0; i < 5; i++) {
      await stub.invokeTool("slack_post_message", { text: `new ${i}` }, "box-1");
    }

    const all = await stub.messages();
    expect(all).toHaveLength(500); // still capped
    expect(all[0]?.seq).toBe(6); // the first five were trimmed away
    expect(all[all.length - 1]?.seq).toBe(505);

    // With an index cursor, `after: 500` would index past a 500-element array and
    // return nothing at all.
    const fresh = await stub.messages(500);
    expect(texts(fresh)).toEqual(["new 0", "new 1", "new 2", "new 3", "new 4"]);

    // And a cursor below the trim window still yields everything that survives.
    expect(await stub.messages(3)).toHaveLength(500);
    expect(await stub.messages(505)).toHaveLength(0);
  });
});
