/**
 * Typed client for the Box Public API v1 (https://docs.ascii.dev/box/api/v1).
 * Every response uses an `{ok, type, ...}` envelope.
 */

export type BoxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error";

/** States where the box can accept prompts and commands right now. */
export const USABLE_STATES: BoxState[] = ["ready", "idle", "running"];
/** States that will become usable on their own; keep polling. */
export const PENDING_STATES: BoxState[] = ["init", "provisioning", "provisioned", "cloning"];

export interface BoxSummary {
  id: string;
  name: string;
  state: BoxState;
  url: string | null;
  ip: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archiveAfter: string | null;
  desktopAvailable: boolean;
  snapshotAvailable: boolean;
}

export type PromptStatus = "sending" | "queued" | "running" | "finished" | "failed";

export interface PromptRun {
  id: string;
  promptId: string;
  boxId: string;
  status: PromptStatus;
  done: boolean;
  createdAt?: string;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface BoxEvent {
  id?: string;
  type: string;
  timestamp?: number;
  taskId?: string;
  data?: {
    content?: string;
    prompt?: string;
    status?: string;
    model?: string;
    is_streaming?: boolean;
    tools?: unknown[];
    [k: string]: unknown;
  };
}

export interface EventsPage {
  events: BoxEvent[];
  pageInfo?: { nextCursor: string | null; hasMore: boolean; limit: number };
}

export interface CommandResult {
  success: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class BoxApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Box API ${status} on ${path}: ${body.slice(0, 400)}`);
    this.name = "BoxApiError";
  }

  /**
   * What is safe to show a user. `message` carries the upstream response body, which
   * can contain internal identifiers and is for logs only.
   */
  get publicMessage(): string {
    return `The sandbox API returned an error (HTTP ${this.status}).`;
  }
}

export class BoxClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://ascii.dev/api/box/v1",
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new BoxApiError(res.status, path, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // --- lifecycle -----------------------------------------------------------

  async create(opts: { ttlSeconds?: number; env?: Record<string, string>; noEnv?: boolean } = {}) {
    const r = await this.request<{ box: BoxSummary }>("POST", "/boxes", { body: opts });
    return r.box;
  }

  /**
   * Fork a template box. Note `env` here REPLACES the env the fork would inherit
   * from the source, and `ttlSeconds` is not accepted — set it with `update()`.
   */
  async fork(templateId: string, opts: { env?: Record<string, string>; noEnv?: boolean } = {}) {
    const r = await this.request<{ id: string; box?: BoxSummary }>(
      "POST",
      `/boxes/${templateId}/fork`,
      { body: opts },
    );
    return r.box ?? ({ id: r.id, state: "provisioning" } as BoxSummary);
  }

  async get(boxId: string) {
    const r = await this.request<{ box: BoxSummary }>("GET", `/boxes/${boxId}`);
    return r.box;
  }

  async update(boxId: string, patch: { name?: string; ttlSeconds?: number | null }) {
    const r = await this.request<{ box: BoxSummary }>("PATCH", `/boxes/${boxId}`, { body: patch });
    return r.box;
  }

  async resume(boxId: string) {
    return this.request<{ id: string; status: string }>("POST", `/boxes/${boxId}/resume`, { body: {} });
  }

  async stop(boxId: string) {
    return this.request<{ id: string; status: string }>("POST", `/boxes/${boxId}/stop`);
  }

  // --- agent ---------------------------------------------------------------

  async prompt(
    boxId: string,
    req: { provider: string; prompt: string; model?: string | null; reasoningEffort?: string | null },
  ) {
    return this.request<{ promptId: string; status: PromptStatus; promptRun?: PromptRun }>(
      "POST",
      `/boxes/${boxId}/prompt`,
      { body: req },
    );
  }

  async promptStatus(boxId: string, promptId: string) {
    const r = await this.request<{ promptRun: PromptRun }>(
      "GET",
      `/boxes/${boxId}/prompts/${promptId}`,
    );
    return r.promptRun;
  }

  async events(
    boxId: string,
    opts: { cursor?: string | null; limit?: number; sort?: "asc" | "desc"; type?: string } = {},
  ) {
    return this.request<EventsPage>("GET", `/boxes/${boxId}/events`, {
      query: {
        cursor: opts.cursor ?? undefined,
        limit: opts.limit,
        sort: opts.sort ?? "asc",
        type: opts.type,
      },
    });
  }

  async interrupt(boxId: string) {
    return this.request<{ id: string; status: string }>("POST", `/boxes/${boxId}/interrupt`);
  }

  /**
   * Open a desktop/VNC view of the box. `publicAccess` makes the returned URL usable
   * without a Box login, which is what lets it be posted into a Slack thread.
   *
   * The response field naming is not pinned down in the public docs, so the known
   * spellings are all accepted and normalized to a single URL.
   */
  async desktop(boxId: string, opts: { publicAccess?: boolean } = {}) {
    const r = await this.request<Record<string, unknown>>("POST", `/boxes/${boxId}/desktop`, {
      body: opts,
    });
    const nested = (r.desktop ?? {}) as Record<string, unknown>;
    const url = [r.url, r.desktopUrl, r.vncUrl, nested.url, nested.vncUrl].find(
      (v): v is string => typeof v === "string" && v.startsWith("http"),
    );
    return { url: url ?? null, raw: r };
  }

  // --- files & commands ----------------------------------------------------

  async command(boxId: string, command: string, opts: { cwd?: string; timeoutSeconds?: number } = {}) {
    return this.request<CommandResult>("POST", `/boxes/${boxId}/commands`, {
      body: { command, ...opts },
    });
  }

  async readFile(boxId: string, path: string, encoding: "utf8" | "base64" = "utf8") {
    return this.request<{ path: string; encoding: string; size: number; content: string }>(
      "GET",
      `/boxes/${boxId}/files`,
      { query: { path, encoding } },
    );
  }

  async writeFile(
    boxId: string,
    path: string,
    content: string,
    encoding: "utf8" | "base64" = "utf8",
  ) {
    return this.request<{ success: boolean; path: string; size: number }>(
      "PUT",
      `/boxes/${boxId}/files`,
      { body: { path, content, encoding } },
    );
  }
}
