import { describe, expect, it } from "vitest";

import app from "../src/app.ts";
import type { Env } from "../src/config.ts";

/**
 * The `/api` gate, driven through the real Hono app inside workerd.
 *
 * These assert a property the README and the security docs both state as fact: the surface
 * fails **closed**, never open. The ordering inside the middleware is what makes that true -
 * the unset check runs before the token comparison - and nothing about the code makes that
 * ordering look load-bearing. Swap the two branches and an unconfigured deployment silently
 * becomes an unauthenticated one, which is exactly the regression these catch.
 *
 * Uses Hono's own `app.request()` test helper, passing a hand-built env: the binding has to
 * vary per test, and a worker's env is fixed once the runtime starts. That works here only
 * because `app.ts` has no runtime dependency on the Durable Object module - it imports the
 * type, not the class - so these run in plain node with no workerd.
 */

const TOKEN = "test-api-token";

const ROUTES = [
  ["GET", "/api/threads/t-auth"],
  ["GET", "/api/threads/t-auth/messages"],
  ["GET", "/api/threads/t-auth/events"],
  ["POST", "/api/threads/t-auth/interrupt"],
  ["DELETE", "/api/threads/t-auth"],
] as const;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/**
 * A stub binding. Only the authorized case reaches it, and the assertion there is that
 * the gate let the request through - not what the Durable Object does with it.
 */
const THREAD_SESSIONS = {
  idFromName: (name: string) => name,
  get: () => ({ state: async () => ({ exists: false }) }),
} as unknown as Env["THREAD_SESSIONS"];

/** Bindings with API_TOKEN forced to whatever this test needs. */
function envWith(apiToken: string | undefined): Env {
  return {
    THREAD_SESSIONS,
    MCP_TOKEN_SECRET: "test-mcp-secret",
    API_TOKEN: apiToken as string,
  } as Env;
}

/**
 * No default for `apiToken`: passing `undefined` explicitly still triggers a default
 * parameter, which would quietly restore the token these tests are trying to remove.
 */
function call(
  method: string,
  path: string,
  token: string | null,
  apiToken: string | undefined,
) {
  return app.request(
    path,
    { method, headers: token !== null ? { authorization: `Bearer ${token}` } : {} },
    envWith(apiToken),
    ctx,
  );
}

describe("/api auth gate", () => {
  it("rejects a request with no bearer token", async () => {
    const res = await call("GET", "/api/threads/t-auth", null, TOKEN);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong token", async () => {
    const res = await call("GET", "/api/threads/t-auth", "not-the-token", TOKEN);
    expect(res.status).toBe(401);
  });

  it("rejects a token that is a prefix of the real one", async () => {
    // timingSafeEqual compares lengths first; this pins that a short token can't pass.
    const res = await call("GET", "/api/threads/t-auth", TOKEN.slice(0, 4), TOKEN);
    expect(res.status).toBe(401);
  });

  it("lets a correct token through", async () => {
    const res = await call("GET", "/api/threads/t-auth", TOKEN, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exists: false });
  });
});

describe("/api with API_TOKEN unset", () => {
  it("returns 503 on every /api route", async () => {
    for (const [method, path] of ROUTES) {
      const res = await call(method, path, TOKEN, undefined);
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(await res.json()).toEqual({ error: "API_TOKEN is not configured" });
    }
  });

  it("still refuses when no token is sent at all", async () => {
    // The dangerous regression is this returning 200: an unset secret must never read as
    // "no auth required".
    const res = await call("GET", "/api/threads/t-auth", null, undefined);
    expect(res.status).toBe(503);
  });

  it("refuses an empty bearer, which could otherwise match an empty secret", async () => {
    const res = await call("GET", "/api/threads/t-auth", "", undefined);
    expect(res.status).toBe(503);
  });

  it("refuses before any handler runs", async () => {
    // A prompt that got through would fork a real sandbox. 503 rather than 202 is proof
    // the middleware answered first.
    const res = await app.request(
      "/api/threads/t-auth-unreached/prompt",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "this must not run" }),
      },
      envWith(undefined),
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it("leaves the non-/api surface alone", async () => {
    // An unset API_TOKEN disables the scripting surface, not the bot: /health is public
    // and /mcp has its own gate.
    const health = await app.request("/health", {}, envWith(undefined), ctx);
    expect(health.status).toBe(200);

    const mcp = await app.request("/mcp", { method: "POST" }, envWith(undefined), ctx);
    expect(mcp.status).toBe(401);
  });
});
