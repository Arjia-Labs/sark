import { fileBytes, type OutFile, type OutMessage, type ThreadMessage, type Transport } from "../transport.ts";

export interface SlackTarget {
  channel: string;
  threadTs: string;
  /** ts of the user message that triggered the run, for reactions. */
  triggerTs?: string;
}

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly slackError: string,
  ) {
    super(`Slack ${method} failed: ${slackError}`);
    this.name = "SlackError";
  }
}

export class SlackClient {
  constructor(private readonly token: string) {}

  async call<T = Record<string, unknown>>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T & { ok: boolean }> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as T & { ok: boolean; error?: string };
    if (!json.ok) throw new SlackError(method, json.error ?? `http_${res.status}`);
    return json;
  }

  /**
   * Several Web API methods reject a JSON body with `invalid_arguments` and require
   * application/x-www-form-urlencoded. It is not only uploads: the read methods
   * (`conversations.replies`, `chat.getPermalink`) behave the same way, and they fail
   * quietly because their callers treat a miss as "no history" or "no link".
   */
  async callForm<T = Record<string, unknown>>(
    method: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T & { ok: boolean }> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) form.set(k, String(v));
    }
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form.toString(),
    });
    const json = (await res.json()) as T & { ok: boolean; error?: string };
    if (!json.ok) throw new SlackError(method, json.error ?? `http_${res.status}`);
    return json;
  }

  /**
   * Find the thread a message belongs to. A `reaction_added` payload carries only
   * `item.{channel,ts}` and never `thread_ts`, so the thread has to be recovered.
   *
   * `conversations.replies` accepts the ts of *any* message in a thread and answers with
   * the parent first, so `messages[0].ts` is the thread_ts. A message that is not in a
   * thread comes back as itself, which is exactly the thread id a mention on it would
   * have produced.
   */
  async resolveThreadTs(channel: string, ts: string): Promise<string> {
    const r = await this.callForm<{ messages?: { ts?: string; thread_ts?: string }[] }>(
      "conversations.replies",
      { channel, ts, limit: 1 },
    );
    const first = r.messages?.[0];
    return first?.thread_ts ?? first?.ts ?? ts;
  }

  /** Start a new top-level thread in a channel. Used by 🍴 to branch a conversation. */
  async postToChannel(channel: string, text: string): Promise<{ ts: string }> {
    const r = await this.call<{ ts: string }>("chat.postMessage", {
      channel,
      text,
      unfurl_links: false,
    });
    return { ts: r.ts };
  }

  /** Rewrite a message anywhere, not just inside a `SlackTransport`'s own thread. */
  async updateText(channel: string, ts: string, text: string): Promise<void> {
    await this.call("chat.update", { channel, ts, text });
  }

  /** Deep link to a thread, for pointing at a fork from the thread it came from. */
  async permalink(channel: string, ts: string): Promise<string | null> {
    try {
      const r = await this.callForm<{ permalink?: string }>("chat.getPermalink", {
        channel,
        message_ts: ts,
      });
      return r.permalink ?? null;
    } catch {
      return null;
    }
  }
}

/** Sends agent output to a single, fixed Slack thread. */
export class SlackTransport implements Transport {
  readonly kind = "slack" as const;
  private readonly client: SlackClient;

  constructor(
    token: string,
    private readonly target: SlackTarget,
  ) {
    this.client = new SlackClient(token);
  }

  async postMessage(m: OutMessage): Promise<{ ts: string }> {
    const r = await this.client.call<{ ts: string }>("chat.postMessage", {
      channel: this.target.channel,
      thread_ts: this.target.threadTs,
      reply_broadcast: m.broadcast ?? false,
      text: m.text,
      ...(m.blocks ? { blocks: m.blocks } : {}),
      unfurl_links: false,
    });
    return { ts: r.ts };
  }

  async updateMessage(ts: string, m: OutMessage): Promise<void> {
    await this.client.call("chat.update", {
      channel: this.target.channel,
      ts,
      text: m.text,
      ...(m.blocks ? { blocks: m.blocks } : {}),
    });
  }

  async addReaction(name: string, ts?: string): Promise<void> {
    try {
      await this.client.call("reactions.add", {
        channel: this.target.channel,
        timestamp: ts ?? this.target.triggerTs ?? this.target.threadTs,
        name,
      });
    } catch (err) {
      // already_reacted / no_reaction are not worth failing a run over
      if (!(err instanceof SlackError)) throw err;
    }
  }

  async removeReaction(name: string, ts?: string): Promise<void> {
    try {
      await this.client.call("reactions.remove", {
        channel: this.target.channel,
        timestamp: ts ?? this.target.triggerTs ?? this.target.threadTs,
        name,
      });
    } catch (err) {
      if (!(err instanceof SlackError)) throw err;
    }
  }

  async uploadFile(f: OutFile): Promise<{ id: string; permalink?: string }> {
    const bytes = fileBytes(f);

    // Step 1 — reserve an upload URL. This endpoint requires form-encoded params.
    const upload = await this.client.callForm<{ upload_url: string; file_id: string }>(
      "files.getUploadURLExternal",
      { filename: f.filename, length: bytes.byteLength },
    );

    // Step 2 — POST the raw bytes to the returned URL.
    const put = await fetch(upload.upload_url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!put.ok) throw new SlackError("files.upload", `http_${put.status}`);

    // Step 3 — finalize and share into the thread. `files` is a JSON *string*.
    const done = await this.client.callForm<{ files: { id: string; permalink?: string }[] }>(
      "files.completeUploadExternal",
      {
        files: JSON.stringify([{ id: upload.file_id, title: f.title ?? f.filename }]),
        channel_id: this.target.channel,
        thread_ts: this.target.threadTs,
        initial_comment: f.initialComment,
      },
    );
    const file = done.files?.[0];
    return { id: file?.id ?? upload.file_id, permalink: file?.permalink };
  }

  async getThread(limit = 50): Promise<ThreadMessage[]> {
    const r = await this.client.callForm<{
      messages: { ts: string; text?: string; user?: string; bot_id?: string }[];
    }>("conversations.replies", {
      channel: this.target.channel,
      ts: this.target.threadTs,
      limit,
    });
    return (r.messages ?? []).map((m) => ({
      ts: m.ts,
      text: m.text ?? "",
      user: m.user,
      bot: Boolean(m.bot_id),
    }));
  }
}
