import type { Transport } from "../transport.ts";

/**
 * Tools handed to the agent inside the box.
 *
 * Note what is absent: there is no `channel` or `thread` parameter anywhere. The
 * destination comes from the bearer token the box was given, so a compromised box
 * cannot post anywhere except the thread that spawned it.
 */
export const TOOLS = [
  {
    name: "slack_post_message",
    description:
      "Post a message into the Slack thread that asked for this work. This is the ONLY way to " +
      "talk to the user - stdout is not shown to them. Returns the message ts, which you can " +
      "pass to slack_update_message later.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: {
          type: "string",
          description:
            "Slack mrkdwn. *bold*, _italic_, `code`, ```block```, <url|label>. " +
            "Markdown headings (#) and [](url) links do NOT render in Slack.",
        },
        broadcast: {
          type: "boolean",
          description: "Also show this reply in the main channel, not just the thread. Use sparingly.",
        },
      },
    },
  },
  {
    name: "slack_update_message",
    description:
      "Edit a message you posted earlier. Use this to turn a progress note into the final answer " +
      "instead of posting many messages.",
    inputSchema: {
      type: "object",
      required: ["ts", "text"],
      properties: {
        ts: { type: "string", description: "ts returned by slack_post_message" },
        text: { type: "string", description: "Replacement text, Slack mrkdwn." },
      },
    },
  },
  {
    name: "slack_add_reaction",
    description: "Add an emoji reaction to the message that triggered this run.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Emoji name without colons, e.g. white_check_mark" },
      },
    },
  },
  {
    name: "slack_upload_file",
    description:
      "Upload a file into the thread — code, logs, diffs, reports, or binary files like images " +
      "and PDFs. Prefer this over a huge message for anything longer than ~3000 characters. " +
      "IMPORTANT: for binary files (png, jpg, pdf, zip, …) base64-encode the bytes and set " +
      'encoding to "base64" — otherwise the file arrives corrupted. Text files can be sent as-is.',
    inputSchema: {
      type: "object",
      required: ["filename", "content"],
      properties: {
        filename: { type: "string", description: "e.g. report.md, patch.diff, chart.png" },
        content: {
          type: "string",
          description: 'File contents. If encoding is "base64", the base64 of the raw bytes.',
        },
        encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: 'Default "utf8". Use "base64" for any binary file.',
        },
        title: { type: "string" },
        initial_comment: { type: "string", description: "Message shown alongside the file." },
      },
    },
  },
  {
    name: "slack_get_thread",
    description:
      "Read the recent messages in this thread, oldest first. Use it when you need context the " +
      "prompt did not include.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 50." } },
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export async function callTool(
  transport: Transport,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "slack_post_message": {
      const text = String(args.text ?? "").trim();
      if (!text) return { content: [{ type: "text", text: "text is required" }], isError: true };
      const { ts } = await transport.postMessage({ text, broadcast: Boolean(args.broadcast) });
      return ok(`Posted. ts=${ts}`);
    }
    case "slack_update_message": {
      await transport.updateMessage(String(args.ts), { text: String(args.text ?? "") });
      return ok("Updated.");
    }
    case "slack_add_reaction": {
      await transport.addReaction(String(args.name ?? "").replace(/:/g, ""));
      return ok("Reaction added.");
    }
    case "slack_upload_file": {
      const r = await transport.uploadFile({
        filename: String(args.filename ?? "file.txt"),
        content: String(args.content ?? ""),
        encoding: args.encoding === "base64" ? "base64" : "utf8",
        title: args.title ? String(args.title) : undefined,
        initialComment: args.initial_comment ? String(args.initial_comment) : undefined,
      });
      return ok(`Uploaded. id=${r.id}${r.permalink ? ` ${r.permalink}` : ""}`);
    }
    case "slack_get_thread": {
      const limit = Number(args.limit ?? 50);
      const messages = await transport.getThread(Number.isFinite(limit) ? limit : 50);
      return ok(JSON.stringify(messages, null, 2));
    }
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
