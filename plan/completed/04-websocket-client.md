# 04 — WebSocket worker connection

**Phase:** 1
**Depends on:** 02

## Goal

`src/worker/connection.ts` — a `YavinConnection` class that handles the WS lifecycle: connect, auth, heartbeat, reconnect with backoff, buffered outbox.

## Scope

- `pnpm add ws @types/ws`.
- Class shape:
  ```ts
  class YavinConnection {
    constructor(opts: { url: string; apiKey: string; logger: Logger });
    on(event: "message", cb: (msg: ServerToWorker) => void): void;
    on(event: "open" | "close", cb: () => void): void;
    send(msg: WorkerToServer): void;     // buffers if not open
    connect(): Promise<void>;
    close(): void;
  }
  ```
- Builds the WS URL from `url` (`http→ws`, `https→wss`) + `/ws?role=worker&token=<urlencoded>`.
- Heartbeat: on `{kind: "ping"}` immediately reply `{kind: "pong"}`. Watchdog: if no ping received for >60s, close and let reconnect kick in.
- Reconnect: exponential backoff, base 500ms, cap 30s, with jitter. Resets on successful connect.
- Outbox: buffer outbound messages when socket isn't OPEN, flush on `open`. Bounded (e.g. 10_000). On overflow, emit a `criticalError` event and stop accepting new sends until drained.
- All inbound JSON parsed and forwarded as typed `ServerToWorker`. Unknown `kind` → log + ignore (the server can close with 4400, which we just observe).
- Logs include `runId` when present in the payload.

## Acceptance criteria

- Unit tests using `ws` server in-test verify:
  - Connection sets `Authorization` via query token correctly.
  - `ping` → `pong` round-trip works.
  - Close → reconnect with backoff (use fake timers).
  - Outbox buffers while closed and flushes on open in order.
- `pnpm typecheck` + lint pass.

## Notes

- This task does NOT handle `run.start` / gate logic — only the transport. Pipeline wiring comes in task 14.
- Do not call `getRun()` from here; consumers do that.

## Implementation notes (2026-05-12)

- **Module:** `src/worker/connection.ts`. Exports `class YavinConnection extends EventEmitter<ConnectionEvents>` and `type YavinConnectionOptions`.
- **Typed events** (use `conn.on("message", …)` etc.):
  - `"open"` — fires on every successful socket open (initial + each reconnect).
  - `"close"` — fires when the socket closes (reconnect is scheduled internally unless `.close()` was called).
  - `"message"` — fires with the typed `ServerToWorker` payload. **Ping messages are NOT re-emitted** — they're answered with a pong internally.
  - `"criticalError"` — fires once when the outbox overflows. Subsequent `send()` calls throw.
- **Constructor knobs (defaults):**
  - `outboxMax = 10_000`
  - `watchdogMs = 60_000` (no inbound traffic for this long → `ws.terminate()` → reconnect path)
  - `backoffBaseMs = 500`, `backoffMaxMs = 30_000`. Backoff is `min(max, base * 2^attempt) + jitter(0..min(250, exp/4))`.
- **WS URL building:** `http://` → `ws://`, `https://` → `wss://`, then append `/ws?role=worker&token=<encodeURIComponent(apiKey)>`. The URL is redacted in logs.
- **Pong is sent immediately** (bypasses the outbox) so it can't be dropped behind a backlog.
- **Reconnect counter (`reconnectAttempt`) is reset to 0** on successful open, so backoff resets after every successful reconnect.
- **`close()` is terminal:** sets `closed = true`, clears timers, closes socket. Further `connect()` rejects.
- **Outbox overflow:** `send()` throws *and* emits `criticalError`. Both signal — caller is expected to handle one or the other.
- **Tests:** `src/__sanity__/connection.test.ts` spins up a real `ws.WebSocketServer` on an ephemeral port. 5 cases: URL contains `role=worker` + urlencoded token; ping → pong; outbox FIFO flush on open; reconnect after server-side `terminate()`; overflow → criticalError + throws.
- **Out of scope (intentional):** `run.start` dispatch, gate handling, `getRun()` calls. Those land in tasks 05 (worker entry) and 14 (orchestrator). The connection only transports messages.
