import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { interpret, isInterruptCommand, slackThreadId } from "../src/slack/events.ts";
import { verifySlackSignature } from "../src/slack/verify.ts";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

function sign(body: string, ts: string, secret = SECRET): Headers {
  const mac = createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return new Headers({
    "x-slack-request-timestamp": ts,
    "x-slack-signature": `v0=${mac}`,
  });
}

describe("slack signature verification", () => {
  const body = JSON.stringify({ type: "event_callback" });
  const now = 1_780_000_000_000;
  const ts = String(Math.floor(now / 1000));

  it("accepts a correctly signed request", async () => {
    const r = await verifySlackSignature(SECRET, sign(body, ts), body, now);
    expect(r.ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const r = await verifySlackSignature(SECRET, sign(body, ts), body + "x", now);
    expect(r).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a request signed with the wrong secret", async () => {
    const r = await verifySlackSignature(SECRET, sign(body, ts, "nope"), body, now);
    expect(r.ok).toBe(false);
  });

  it("rejects a replayed request older than five minutes", async () => {
    const old = String(Math.floor(now / 1000) - 600);
    const r = await verifySlackSignature(SECRET, sign(body, old), body, now);
    expect(r).toEqual({ ok: false, reason: "stale timestamp" });
  });

  it("rejects a request with no signature headers", async () => {
    const r = await verifySlackSignature(SECRET, new Headers(), body, now);
    expect(r.ok).toBe(false);
  });
});

describe("event interpretation", () => {
  const mention = {
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    event: {
      type: "app_mention",
      channel: "C1",
      user: "U1",
      text: "<@U0BOT> run the tests",
      ts: "1780347055.370",
    },
  };

  it("turns a mention into a prompt with the mention stripped", () => {
    const r = interpret(mention);
    expect(r.kind).toBe("prompt");
    if (r.kind !== "prompt") return;
    expect(r.request.text).toBe("run the tests");
    expect(r.threadId).toBe(slackThreadId("T1", "C1", "1780347055.370"));
    expect(r.request.threadId).toBe(r.threadId);
    expect(r.request.slack?.triggerTs).toBe("1780347055.370");
  });

  it("keeps replies in the thread they came from", () => {
    const r = interpret({
      ...mention,
      event: { ...mention.event, ts: "1780347099.000", thread_ts: "1780347055.370" },
    });
    if (r.kind !== "prompt") throw new Error("expected prompt");
    expect(r.threadId).toBe(slackThreadId("T1", "C1", "1780347055.370"));
    expect(r.request.slack?.triggerTs).toBe("1780347099.000");
  });

  it("ignores its own messages so it cannot loop", () => {
    const r = interpret({ ...mention, event: { ...mention.event, bot_id: "B1" } });
    expect(r).toEqual({ kind: "ignore", reason: "bot message" });
  });

  it("ignores edits, joins and other subtypes", () => {
    const r = interpret({ ...mention, event: { ...mention.event, subtype: "message_changed" } });
    expect(r.kind).toBe("ignore");
  });

  it("ignores a mention with no actual text", () => {
    const r = interpret({ ...mention, event: { ...mention.event, text: "<@U0BOT>   " } });
    expect(r).toEqual({ kind: "ignore", reason: "empty message" });
  });

  it("handles direct messages", () => {
    const r = interpret({
      ...mention,
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "hello",
        ts: "1780347055.370",
      },
    });
    expect(r.kind).toBe("prompt");
  });

  it("ignores ordinary channel messages that are not mentions", () => {
    const r = interpret({
      ...mention,
      event: { type: "message", channel: "C1", user: "U1", text: "hi", ts: "1780347055.370" },
    });
    expect(r.kind).toBe("ignore");
  });
});

describe("interrupt command", () => {
  it("matches only a bare stop word", () => {
    for (const yes of ["stop", "Stop", "cancel!", " abort "]) {
      expect(isInterruptCommand(yes)).toBe(true);
    }
    for (const no of ["stop the deploy", "cancel my subscription", ""]) {
      expect(isInterruptCommand(no)).toBe(false);
    }
  });
});
