import { describe, expect, it } from "vitest";

import {
  mintThreadToken,
  THREAD_TOKEN_MAX_AGE_SECONDS,
  timingSafeEqual,
  verifyThreadToken,
} from "../src/auth/token.ts";
import { isAllowed, type Env } from "../src/config.ts";

const SECRET = "test-secret";
const BOX = "box_abc";

describe("thread tokens", () => {
  it("round-trips the thread id and the box it was minted for", async () => {
    const token = await mintThreadToken(SECRET, "T1:C1:1780.1", BOX);
    const payload = await verifyThreadToken(SECRET, token);
    expect(payload?.tid).toBe("T1:C1:1780.1");
    expect(payload?.bid).toBe(BOX);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintThreadToken("other-secret", "T1:C1:1780.1", BOX);
    expect(await verifyThreadToken(SECRET, token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await mintThreadToken(SECRET, "thread-a", BOX);
    const forged = Buffer.from(JSON.stringify({ tid: "thread-b", bid: BOX, iat: 1 }))
      .toString("base64url");
    expect(await verifyThreadToken(SECRET, `${forged}.${token.split(".")[1]}`)).toBeNull();
  });

  it("expires a token once it is past its max age", async () => {
    const mintedAt = 1_780_000_000_000;
    const token = await mintThreadToken(SECRET, "thread-a", BOX, mintedAt);

    const stillFresh = mintedAt + (THREAD_TOKEN_MAX_AGE_SECONDS - 60) * 1000;
    expect(await verifyThreadToken(SECRET, token, stillFresh)).not.toBeNull();

    const expired = mintedAt + (THREAD_TOKEN_MAX_AGE_SECONDS + 60) * 1000;
    expect(await verifyThreadToken(SECRET, token, expired)).toBeNull();
  });

  it("rejects a token issued in the future", async () => {
    const now = 1_780_000_000_000;
    const token = await mintThreadToken(SECRET, "thread-a", BOX, now + 3600_000);
    expect(await verifyThreadToken(SECRET, token, now)).toBeNull();
  });

  it("rejects a validly signed token that carries no box binding", async () => {
    // Signature alone is not enough: the payload shape is part of the contract.
    const body = Buffer.from(JSON.stringify({ tid: "thread-a", iat: Math.floor(Date.now() / 1000) }))
      .toString("base64url");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const b64 = Buffer.from(new Uint8Array(sig)).toString("base64url");
    expect(await verifyThreadToken(SECRET, `${body}.${b64}`)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", "nodot", ".", "a.b"]) {
      expect(await verifyThreadToken(SECRET, bad)).toBeNull();
    }
  });

  it("compares api tokens without length-independent early exit", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("allowlist", () => {
  const base = { ALLOWED_TEAMS: "", ALLOWED_CHANNELS: "", ALLOWED_USERS: "" } as Env;

  it("fails closed when nothing is configured", () => {
    expect(isAllowed(base, { team: "T1", channel: "C1", user: "U1" }).ok).toBe(false);
  });

  it("allows a listed channel", () => {
    const env = { ...base, ALLOWED_CHANNELS: "C1, C2" } as Env;
    expect(isAllowed(env, { channel: "C1", user: "U9" }).ok).toBe(true);
    expect(isAllowed(env, { channel: "C3", user: "U9" }).ok).toBe(false);
  });

  it("allows a listed user in any channel", () => {
    const env = { ...base, ALLOWED_USERS: "U1" } as Env;
    expect(isAllowed(env, { channel: "C-anything", user: "U1" }).ok).toBe(true);
  });

  it("enforces the team restriction first", () => {
    const env = { ...base, ALLOWED_TEAMS: "T1", ALLOWED_CHANNELS: "C1" } as Env;
    expect(isAllowed(env, { team: "T1", channel: "C1" }).ok).toBe(true);
    expect(isAllowed(env, { team: "T2", channel: "C1" }).ok).toBe(false);
  });
});
