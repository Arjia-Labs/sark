/**
 * Minimal stateless MCP server over streamable HTTP.
 *
 * Only what `claude mcp add --transport http` actually needs: initialize,
 * notifications/initialized, tools/list, tools/call, ping. No session ids, no SSE —
 * every request is self-describing and authenticated by its bearer token.
 */
import { TOOLS } from "./tools.ts";

export const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type ToolInvoker = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** A batch is one client turn, not a work queue: cap it so one request can't fan out. */
export const MAX_BATCH_SIZE = 32;
/** Bounds how much a sandbox can push through a single POST. */
const MAX_BODY_BYTES = 1_000_000;

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

async function handleOne(req: JsonRpcRequest, invoke: ToolInvoker): Promise<unknown | null> {
  switch (req.method) {
    case "initialize":
      return result(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "slack-thread", version: "0.1.0" },
        instructions:
          "Use these tools to talk to the Slack thread that requested this work. " +
          "Nothing you print to stdout reaches the user.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response

    case "ping":
      return result(req.id, {});

    case "tools/list":
      return result(req.id, { tools: TOOLS });

    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return result(req.id, await invoke(name, args));
      } catch (err) {
        // Tool failures are reported in-band so the model can react, not as RPC errors.
        return result(req.id, {
          content: [{ type: "text", text: `Tool ${name} failed: ${(err as Error).message}` }],
          isError: true,
        });
      }
    }

    case "resources/list":
      return result(req.id, { resources: [] });
    case "prompts/list":
      return result(req.id, { prompts: [] });

    default:
      return req.id === undefined
        ? null
        : error(req.id, METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
}

/** Handles a single POST to the MCP endpoint, including JSON-RPC batches. */
export async function handleMcpRequest(request: Request, invoke: ToolInvoker): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // No server-initiated stream and no session state to tear down.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json(error(null, INVALID_REQUEST, "Request body too large"), { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(error(null, PARSE_ERROR, "Invalid JSON"), { status: 400 });
  }

  const batch = Array.isArray(body) ? body : [body];
  if (!batch.length) return Response.json(error(null, INVALID_REQUEST, "Empty batch"), { status: 400 });
  if (batch.length > MAX_BATCH_SIZE) {
    return Response.json(
      error(null, INVALID_REQUEST, `Batch too large (max ${MAX_BATCH_SIZE})`),
      { status: 400 },
    );
  }

  const responses: unknown[] = [];
  for (const item of batch) {
    const req = item as JsonRpcRequest;
    if (!req || typeof req.method !== "string") {
      responses.push(error(null, INVALID_REQUEST, "Missing method"));
      continue;
    }
    try {
      const res = await handleOne(req, invoke);
      // A request with no id is a notification: it never gets a response, whatever
      // the handler produced.
      if (res !== null && req.id !== undefined) responses.push(res);
    } catch (err) {
      console.error("mcp method failed", req.method, (err as Error).stack ?? (err as Error).message);
      // A notification gets no response, not even a failure one.
      if (req.id !== undefined) responses.push(error(req.id, INTERNAL_ERROR, "Internal error"));
    }
  }

  // All-notification batches get 202 with no body, per the MCP spec.
  if (!responses.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
