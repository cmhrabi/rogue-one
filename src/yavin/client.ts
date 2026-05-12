import type { Event, Run, Stage, TicketProvider } from "../protocol.js";

export class YavinApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `yavin API error: HTTP ${status}`);
    this.name = "YavinApiError";
    this.status = status;
    this.body = body;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface YavinClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: FetchLike;
  /** Total request timeout in ms (per attempt). Default 30s. */
  timeoutMs?: number;
  /** Override base retry delay (5xx) in ms. Default 500. */
  retryBaseMs?: number;
}

export interface WhoAmI {
  kind: "apiKey";
  userId: string;
  keyId: string;
  label: string;
}

export interface CreateRunInput {
  repoConfigId?: string;
  ticketProvider: TicketProvider;
  ticketId: string;
  ticketUrl: string;
  instructions: string;
}

export interface GetRunResponse {
  run: Run;
  stages: Stage[];
  events: Event[];
}

export interface CreateRunResponse {
  run: Run;
  stages: Stage[];
}

export class YavinClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryBaseMs: number;

  constructor(opts: YavinClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.YAVIN_URL ?? process.env.YAVIN_BASE_URL;
    const apiKey = opts.apiKey ?? process.env.YAVIN_API_KEY;
    if (!baseUrl) {
      throw new Error("YavinClient: baseUrl is required (set YAVIN_URL or YAVIN_BASE_URL).");
    }
    if (!apiKey) {
      throw new Error("YavinClient: apiKey is required (set YAVIN_API_KEY).");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
  }

  getHealth(): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/api/health", { method: "GET" }, { auth: false });
  }

  whoami(): Promise<WhoAmI> {
    return this.request<WhoAmI>("/api/whoami", { method: "GET" }, { auth: true });
  }

  createRun(input: CreateRunInput): Promise<CreateRunResponse> {
    return this.request<CreateRunResponse>(
      "/api/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      { auth: true },
    );
  }

  getRun(id: string): Promise<GetRunResponse> {
    return this.request<GetRunResponse>(
      `/api/runs/${encodeURIComponent(id)}`,
      { method: "GET" },
      { auth: true },
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    opts: { auth: boolean },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    if (opts.auth) headers.set("authorization", `Bearer ${this.apiKey}`);
    const callInit: RequestInit = { ...init, headers };

    const attempt = async (): Promise<Response> => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        return await this.fetchFn(url, { ...callInit, signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await attempt();
    if (res.status >= 500) {
      const jitter = Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, this.retryBaseMs + jitter));
      res = await attempt();
    }

    if (res.status >= 400) {
      const body = await readBodySafe(res);
      throw new YavinApiError(res.status, body);
    }

    return (await res.json()) as T;
  }
}

async function readBodySafe(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
