import { describe, expect, it } from "vitest";

import { handleMcpRequest, MAX_BATCH_SIZE, PROTOCOL_VERSION } from "../src/mcp/server.ts";
import { callTool, TOOLS } from "../src/mcp/tools.ts";
import { fileBytes, MemoryTransport, type ThreadMessage } from "../src/transport.ts";

function log() {
  let messages: ThreadMessage[] = [];
  return {
    read: async () => messages,
    write: async (m: ThreadMessage[]) => {
      messages = m;
    },
    all: () => messages,
  };
}

function rpc(body: unknown): Request {
  return new Request("https://worker/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const noopInvoke = async () => ({ content: [{ type: "text" as const, text: "ok" }] });

describe("mcp server", () => {
  it("advertises tools on initialize", async () => {
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      noopInvoke,
    );
    const json = (await res.json()) as any;
    expect(json.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("lists every tool with a schema", async () => {
    const res = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), noopInvoke);
    const json = (await res.json()) as any;
    expect(json.result.tools).toHaveLength(TOOLS.length);
    for (const tool of json.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("returns 202 with no body for notifications", async () => {
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
      noopInvoke,
    );
    expect(res.status).toBe(202);
  });

  it("reports tool failures in-band so the model can react", async () => {
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slack_post_message" } }),
      async () => {
        throw new Error("slack exploded");
      },
    );
    const json = (await res.json()) as any;
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("slack exploded");
  });

  it("returns a JSON-RPC error for unknown methods", async () => {
    const res = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 4, method: "nope" }), noopInvoke);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32601);
  });

  it("handles batches", async () => {
    const res = await handleMcpRequest(
      rpc([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
      noopInvoke,
    );
    const json = (await res.json()) as any[];
    expect(json).toHaveLength(2); // the notification produces no response
  });

  it("rejects invalid JSON", async () => {
    const res = await handleMcpRequest(
      new Request("https://worker/mcp", { method: "POST", body: "{" }),
      noopInvoke,
    );
    expect(res.status).toBe(400);
  });

  it("caps batch size so one request cannot fan out", async () => {
    const big = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "ping",
    }));
    const res = await handleMcpRequest(rpc(big), noopInvoke);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32600);
  });

  it("accepts a batch at exactly the cap", async () => {
    const atCap = Array.from({ length: MAX_BATCH_SIZE }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "ping",
    }));
    const res = await handleMcpRequest(rpc(atCap), noopInvoke);
    expect((await res.json()) as any[]).toHaveLength(MAX_BATCH_SIZE);
  });

  it("gives a notification no response even when its handler produces one", async () => {
    // A tools/call with no id is still a notification; the spec says answer nothing.
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", method: "tools/call", params: { name: "slack_post_message" } }),
      async () => {
        throw new Error("secret internal detail");
      },
    );
    expect(res.status).toBe(202);
  });

  it("rejects an oversized body before parsing it", async () => {
    const res = await handleMcpRequest(
      new Request("https://worker/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "5000000" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      noopInvoke,
    );
    expect(res.status).toBe(413);
  });
});

describe("tools", () => {
  it("posts into the bound thread and returns a ts", async () => {
    const l = log();
    const r = await callTool(new MemoryTransport(l), "slack_post_message", { text: "hi" });
    expect(r.isError).toBeFalsy();
    expect(l.all()[0]?.text).toBe("hi");
  });

  it("refuses an empty message rather than posting nothing", async () => {
    const r = await callTool(new MemoryTransport(log()), "slack_post_message", { text: "  " });
    expect(r.isError).toBe(true);
  });

  it("edits a previous message in place", async () => {
    const l = log();
    const transport = new MemoryTransport(l);
    await callTool(transport, "slack_post_message", { text: "working" });
    await callTool(transport, "slack_update_message", { ts: "m1", text: "done" });
    expect(l.all()[0]?.text).toBe("done");
  });

  it("records uploaded files", async () => {
    const l = log();
    await callTool(new MemoryTransport(l), "slack_upload_file", {
      filename: "out.txt",
      content: "body",
    });
    expect(l.all()[0]?.text).toContain("out.txt");
  });

  it("rejects unknown tools", async () => {
    const r = await callTool(new MemoryTransport(log()), "rm_rf", {});
    expect(r.isError).toBe(true);
  });

  it("decodes base64 file content to exact bytes, not mangled text", () => {
    // 8-byte PNG signature — the classic binary-through-text corruption case.
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const b64 = btoa(String.fromCharCode(...png));
    expect(Array.from(fileBytes({ filename: "x.png", content: b64, encoding: "base64" }))).toEqual(
      Array.from(png),
    );
    // utf8 stays the default for text.
    expect(Array.from(fileBytes({ filename: "x.txt", content: "hi" }))).toEqual([104, 105]);
  });

  it("hands out sequence numbers that survive the log being trimmed", async () => {
    // `messages?after=` is a cursor over these, so they must not restart at 1 when the
    // recorded log rolls over its 500-entry cap.
    const l = log();
    const transport = new MemoryTransport(l);
    for (let i = 0; i < 520; i++) await transport.postMessage({ text: `m${i}` });
    const all = l.all();
    expect(all).toHaveLength(500);
    expect(all[all.length - 1]?.seq).toBe(520);
    // Strictly increasing, no repeats after the trim.
    const seqs = all.map((m) => m.seq ?? 0);
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!)).toBe(true);
  });

  it("has no channel or thread parameter anywhere", () => {
    // The destination comes from the bearer token, never from the model.
    for (const tool of TOOLS) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      expect(props).not.toContain("channel");
      expect(props).not.toContain("thread_ts");
    }
  });
});
