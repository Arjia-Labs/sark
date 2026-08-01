/**
 * Where agent output goes.
 *
 * The MCP tool handlers and the Durable Object only ever talk to this interface, so
 * the exact same code path is exercised whether the trigger came from Slack or from
 * the Slack-free /api surface.
 */

export interface OutMessage {
  text: string;
  blocks?: unknown[];
  /** Slack only: also send the message to the channel, not just the thread. */
  broadcast?: boolean;
}

export interface OutFile {
  filename: string;
  content: string;
  /** How `content` is encoded. Binary files (images, PDFs, …) must be base64. */
  encoding?: "utf8" | "base64";
  title?: string;
  initialComment?: string;
}

/** Decode an OutFile's content to the raw bytes to upload. */
export function fileBytes(f: OutFile): Uint8Array {
  if (f.encoding === "base64") {
    const bin = atob(f.content.replace(/\s/g, ""));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(f.content);
}

export interface ThreadMessage {
  ts: string;
  text: string;
  user?: string;
  bot?: boolean;
  /**
   * Monotonic per-thread sequence number, assigned by `MemoryTransport`. Array position
   * is not a usable cursor because the recorded log is trimmed to the last
   * `MAX_RECORDED` entries; this keeps increasing across that trim.
   */
  seq?: number;
}

export interface Transport {
  readonly kind: "slack" | "memory";
  postMessage(m: OutMessage): Promise<{ ts: string }>;
  updateMessage(ts: string, m: OutMessage): Promise<void>;
  addReaction(name: string, ts?: string): Promise<void>;
  removeReaction(name: string, ts?: string): Promise<void>;
  uploadFile(f: OutFile): Promise<{ id: string; permalink?: string }>;
  getThread(limit?: number): Promise<ThreadMessage[]>;
}

/** Persistence hook so MemoryTransport can live in Durable Object storage. */
export interface MessageLog {
  read(): Promise<ThreadMessage[]>;
  write(messages: ThreadMessage[]): Promise<void>;
}

const MAX_RECORDED = 500;

/**
 * Records everything in the session instead of sending it anywhere. This is what
 * `/api/threads/{id}/messages` reads back, and what makes the bot testable and
 * scriptable without a Slack workspace.
 */
export class MemoryTransport implements Transport {
  readonly kind = "memory" as const;

  constructor(private readonly log: MessageLog) {}

  /** Next sequence number, continuing past anything the trim has already dropped. */
  private static nextSeq(all: ThreadMessage[]): number {
    return (all[all.length - 1]?.seq ?? all.length) + 1;
  }

  private async append(m: Omit<ThreadMessage, "seq">): Promise<void> {
    const all = await this.log.read();
    all.push({ ...m, seq: MemoryTransport.nextSeq(all) });
    await this.log.write(all.slice(-MAX_RECORDED));
  }

  async postMessage(m: OutMessage): Promise<{ ts: string }> {
    const all = await this.log.read();
    const seq = MemoryTransport.nextSeq(all);
    const ts = `m${seq}`;
    all.push({ ts, text: m.text, bot: true, seq });
    await this.log.write(all.slice(-MAX_RECORDED));
    return { ts };
  }

  async updateMessage(ts: string, m: OutMessage): Promise<void> {
    const all = await this.log.read();
    const found = all.find((x) => x.ts === ts);
    if (found) found.text = m.text;
    await this.log.write(all);
  }

  async addReaction(name: string, ts?: string): Promise<void> {
    await this.append({ ts: `reaction:${name}:${ts ?? "-"}`, text: `:${name}:`, bot: true });
  }

  async removeReaction(): Promise<void> {
    // No-op: the recorded log is append-only.
  }

  async uploadFile(f: OutFile): Promise<{ id: string }> {
    const all = await this.log.read();
    const seq = MemoryTransport.nextSeq(all);
    const id = `f${seq}`;
    all.push({
      ts: id,
      text: `[file ${f.filename}] ${f.initialComment ?? ""}\n${f.content}`.trim(),
      bot: true,
      seq,
    });
    await this.log.write(all.slice(-MAX_RECORDED));
    return { id };
  }

  async getThread(limit = 50): Promise<ThreadMessage[]> {
    return (await this.log.read()).slice(-limit);
  }
}
