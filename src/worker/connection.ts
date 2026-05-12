import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Logger } from "../util/log.js";
import type { ServerToWorker, WorkerToServer } from "../protocol.js";

export interface YavinConnectionOptions {
  url: string;
  apiKey: string;
  logger: Logger;
  /** Max outbox size before we emit criticalError and refuse new sends. */
  outboxMax?: number;
  /** Watchdog timeout — close socket if no inbound traffic for this long. */
  watchdogMs?: number;
  /** Base backoff for reconnect in ms. */
  backoffBaseMs?: number;
  /** Cap backoff at this many ms. */
  backoffMaxMs?: number;
  /** Injected WebSocket constructor (for tests). */
  wsCtor?: typeof WebSocket;
}

type ConnectionEvents = {
  open: [];
  close: [];
  message: [ServerToWorker];
  criticalError: [Error];
};

/**
 * WS lifecycle for the rogue-one worker. Handles auth via query token,
 * server pings (replies pong, watchdog on idle), reconnect with exponential
 * backoff + jitter, and an outbox that buffers sends while disconnected.
 *
 * Does NOT implement pipeline / run.start handling — consumers subscribe to
 * `"message"` and dispatch.
 */
export class YavinConnection extends EventEmitter<ConnectionEvents> {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly outboxMax: number;
  private readonly watchdogMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly wsCtor: typeof WebSocket;

  private ws: WebSocket | null = null;
  private outbox: WorkerToServer[] = [];
  private outboxStalled = false;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private openResolvers: Array<() => void> = [];

  constructor(opts: YavinConnectionOptions) {
    super();
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.logger = opts.logger;
    this.outboxMax = opts.outboxMax ?? 10_000;
    this.watchdogMs = opts.watchdogMs ?? 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.wsCtor = opts.wsCtor ?? WebSocket;
  }

  /** Open the socket. Resolves on the first successful open. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("YavinConnection is closed."));
    return new Promise<void>((resolve, reject) => {
      this.openResolvers.push(resolve);
      try {
        this.openSocket();
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Permanently close. No further reconnects. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearWatchdog();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  /**
   * Enqueue a message. Sends immediately if OPEN, otherwise buffers.
   * Throws if the outbox has overflowed (criticalError state).
   */
  send(msg: WorkerToServer): void {
    if (this.outboxStalled) {
      throw new Error("YavinConnection outbox stalled — refusing to send.");
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (this.outbox.length >= this.outboxMax) {
      this.outboxStalled = true;
      const err = new Error(
        `YavinConnection outbox overflow at ${this.outboxMax} messages.`,
      );
      this.logger.error({ outboxMax: this.outboxMax }, "outbox overflow");
      this.emit("criticalError", err);
      throw err;
    }
    this.outbox.push(msg);
  }

  /** Current outbox length (useful for tests / metrics). */
  get pendingCount(): number {
    return this.outbox.length;
  }

  // ---- internals ---------------------------------------------------------

  private openSocket(): void {
    const wsUrl = this.buildWsUrl();
    this.logger.debug({ wsUrl: redactToken(wsUrl) }, "yavin ws: connecting");
    const ws = new this.wsCtor(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.resetWatchdog();
      this.flushOutbox();
      this.emit("open");
      const resolvers = this.openResolvers;
      this.openResolvers = [];
      for (const r of resolvers) r();
      this.logger.info("yavin ws: open");
    });

    ws.on("message", (raw) => {
      this.resetWatchdog();
      let msg: ServerToWorker;
      try {
        msg = JSON.parse(raw.toString()) as ServerToWorker;
      } catch (err) {
        this.logger.warn({ err }, "yavin ws: failed to parse incoming message");
        return;
      }
      if (msg.kind === "ping") {
        this.sendImmediate({ kind: "pong" });
        return;
      }
      const runId = "runId" in msg ? msg.runId : undefined;
      this.logger.debug({ runId, kind: msg.kind }, "yavin ws: message");
      this.emit("message", msg);
    });

    ws.on("close", () => {
      this.logger.info("yavin ws: closed");
      this.clearWatchdog();
      this.ws = null;
      this.emit("close");
      if (!this.closed) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.logger.warn({ err: err.message }, "yavin ws: error");
      // 'close' will follow; reconnect is scheduled there.
    });
  }

  private buildWsUrl(): string {
    let base = this.url;
    if (base.startsWith("http://")) base = "ws://" + base.slice("http://".length);
    else if (base.startsWith("https://")) base = "wss://" + base.slice("https://".length);
    base = base.replace(/\/+$/, "");
    return `${base}/ws?role=worker&token=${encodeURIComponent(this.apiKey)}`;
  }

  private sendImmediate(msg: WorkerToServer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private flushOutbox(): void {
    while (this.outbox.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = this.outbox.shift();
      if (msg) this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.computeBackoff();
    this.reconnectAttempt += 1;
    this.logger.info({ delay, attempt: this.reconnectAttempt }, "yavin ws: reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.openSocket();
    }, delay);
  }

  private computeBackoff(): number {
    const exp = Math.min(
      this.backoffMaxMs,
      this.backoffBaseMs * Math.pow(2, this.reconnectAttempt),
    );
    const jitter = Math.floor(Math.random() * Math.min(250, exp / 4 + 1));
    return exp + jitter;
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.logger.warn({ watchdogMs: this.watchdogMs }, "yavin ws: watchdog fired");
      this.ws?.terminate();
    }, this.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}

function redactToken(wsUrl: string): string {
  return wsUrl.replace(/token=[^&]+/, "token=…");
}
