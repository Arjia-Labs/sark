import { afterEach, describe, expect, it, vi } from "vitest";

import { SlackClient, SlackTransport } from "../src/slack/api.ts";

/**
 * Which Slack methods need form encoding.
 *
 * Slack rejects a JSON body on several methods with `invalid_arguments`, and the read
 * methods are the dangerous ones: their callers treat a failure as "no history" or "no
 * link" and carry on, so getting this wrong is silent. `conversations.replies` was doing
 * exactly that - the agent received no thread history at all, and reaction controls could
 * not resolve a thread - and nothing failed loudly enough to notice.
 *
 * These assert the wire format rather than the result, because the wire format is the bug.
 */

const CALLS: { method: string; contentType: string; body: string }[] = [];

function stubSlack(payload: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    CALLS.push({
      method: href.split("/api/")[1] ?? href,
      contentType: String((init?.headers as Record<string, string>)?.["content-type"] ?? ""),
      body: String(init?.body ?? ""),
    });
    return new Response(JSON.stringify({ ok: true, ...payload }), {
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => {
  CALLS.length = 0;
  vi.unstubAllGlobals();
});

const target = { channel: "C1", threadTs: "111.222" };

describe("form-encoded Slack methods", () => {
  it("sends conversations.replies as a form when reading thread history", async () => {
    stubSlack({ messages: [{ ts: "1", text: "hi" }] });
    await new SlackTransport("xoxb-test", target).getThread(30);

    const call = CALLS.find((c) => c.method === "conversations.replies");
    expect(call?.contentType).toContain("application/x-www-form-urlencoded");
    expect(call?.body).toContain("channel=C1");
    expect(call?.body).toContain("limit=30");
  });

  it("sends conversations.replies as a form when resolving a reaction's thread", async () => {
    stubSlack({ messages: [{ ts: "900.1", thread_ts: "900.1" }] });
    const ts = await new SlackClient("xoxb-test").resolveThreadTs("C1", "999.9");

    expect(ts).toBe("900.1");
    const call = CALLS.find((c) => c.method === "conversations.replies");
    expect(call?.contentType).toContain("application/x-www-form-urlencoded");
  });

  it("sends chat.getPermalink as a form", async () => {
    stubSlack({ permalink: "https://slack.com/archives/C1/p111" });
    const link = await new SlackClient("xoxb-test").permalink("C1", "111.222");

    expect(link).toBe("https://slack.com/archives/C1/p111");
    expect(CALLS.find((c) => c.method === "chat.getPermalink")?.contentType).toContain(
      "application/x-www-form-urlencoded",
    );
  });

  it("still sends chat.postMessage as JSON, which it requires for blocks", async () => {
    stubSlack({ ts: "1.1" });
    await new SlackTransport("xoxb-test", target).postMessage({
      text: "hi",
      blocks: [{ type: "section" }],
    });

    const call = CALLS.find((c) => c.method === "chat.postMessage");
    expect(call?.contentType).toContain("application/json");
    // Blocks are structured; form encoding would flatten them to "[object Object]".
    expect(JSON.parse(call!.body).blocks).toEqual([{ type: "section" }]);
  });

  it("returns no permalink rather than throwing when Slack refuses", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_arguments" })),
    );
    // The fork announcement is still worth posting without a link.
    expect(await new SlackClient("xoxb-test").permalink("C1", "1")).toBeNull();
  });
});

describe("fork announcement", () => {
  it("links the source thread and names the sandbox once both are known", async () => {
    const { forkAnnouncement } = await import("../src/do/fork-message.ts");
    const text = forkAnnouncement({
      actor: "U123",
      sourceLink: "https://slack.com/archives/C1/p111",
      boxId: "bx_abc",
    });
    expect(text).toContain("<@U123>");
    expect(text).toContain("<https://slack.com/archives/C1/p111|another thread>");
    expect(text).toContain("`bx_abc`");
    expect(text).toContain("copy");
  });

  it("degrades to plain text when the permalink call failed", async () => {
    const { forkAnnouncement } = await import("../src/do/fork-message.ts");
    const text = forkAnnouncement({ sourceLink: null });
    expect(text).toContain("another thread");
    expect(text).not.toContain("<http");
    expect(text).not.toContain("undefined");
  });
});
