# 05 — `rogue-one worker` entrypoint

**Phase:** 1
**Depends on:** 03, 04

## Goal

`rogue-one worker` boots, validates config, connects to yavin-iv, claims any in-flight runs from the previous process, and stub-completes the research stage for any `run.start` it receives.

## Scope

- `src/cli/index.ts` registers `commander` commands; add a `worker` subcommand that calls `src/worker/index.ts:startWorker()`.
- `startWorker()`:
  1. Reads + validates env (`YAVIN_URL`, `YAVIN_API_KEY`, optional `ROGUE_ONE_WORKER_LABEL`). Bail with a clear message if missing.
  2. `getHealth()` and `whoami()` to fail fast on bad config.
  3. Constructs `YavinConnection` and connects.
  4. On `run.start`, send a stub flow:
     - `stage.started` for `research`
     - one `event.append` of kind `log` saying "stub worker received run X"
     - `stage.completed` for `research` with a placeholder `ResearchOutput`
     - `gate.await` `post_research` with that output as payload
  5. On `gate.decided`, log it. Do nothing else (real pipeline lands in Phase 3).
  6. On `run.cancel`, log it.
  7. SIGINT/SIGTERM: close the connection cleanly and exit 0.
- Reconciliation on startup: not yet — handled in task 23. For now, just log if `whoami` succeeds.

## Acceptance criteria

- `node bin/rogue-one worker` against a running yavin-iv dev server:
  - Connects, prints whoami label.
  - Stays alive answering pings.
  - Responds to a manually-created run with a `gate.await` visible in the yavin-iv UI.
- Ctrl-C exits cleanly.

## Notes

- Use `pino` for logs. Include `runId` field on every relevant log line.
- Don't validate the stub research output yet — validation tightens up in task 10.

## Implementation notes (2026-05-12)

- **Module:** `src/worker/index.ts`. Exports `startWorker(opts?: StartWorkerOptions): Promise<StartedWorker>` plus the `StartWorkerOptions` / `StartedWorker` types.
- **Injection points** (for tests and future supervisors): `opts.client` (a `YavinClient`), `opts.connection` (a `YavinConnection`), `opts.logger` (pino), and `opts.installSignalHandlers` (default `true`; set `false` in tests).
- **Env validation is lazy:** only runs when `client` or `connection` need to be constructed. If both are injected, env is not read — keeps unit tests env-free.
- **Required env:** `YAVIN_URL` (or `YAVIN_BASE_URL`) and `YAVIN_API_KEY`. `ROGUE_ONE_WORKER_LABEL` is optional and logged if present.
- **Startup sequence:** `getHealth()` → `whoami()` (fail-fast on bad config — `apiKeyLabel` is logged) → `new YavinConnection(...)` → `connection.on("message", handleMessage)` → `await connection.connect()`.
- **`run.start` stub flow** (4 messages, in order):
  1. `stage.started` with a placeholder `Stage` (id `""`, status `running`, attempt `1`, output `null`) — `plan/context.md` says the server upserts by `(runId, kind)` so id is ignored.
  2. `event.append` with `EventInput { runId, stageId: null, kind: "log", payload: { message: "stub worker received run <id>" } }`.
  3. `stage.completed` with the same stage object but `status: "completed"` and `output = { brief, citations }`.
  4. `gate.await` with `gateKind: "post_research"` and the same output as `payload`.
- **Stub research output:** `{ brief: "stub research brief", citations: [] }`. **No zod validation** — that's task 10's job.
- **Protocol gotchas caught:**
  - `gate.await`'s field is **`gateKind`**, not `gate` (the WS protocol uses `gateKind` everywhere).
  - `event.append` wraps `EventInput` under an `event` key — `{ kind: "event.append", event: { runId, stageId, kind, payload } }`.
- **Signal handlers:** `SIGINT` / `SIGTERM` once-handlers call `stop()` then `process.exit(0)`. Tests pass `installSignalHandlers: false` to avoid polluting process state.
- **`stop()`** unsubscribes the message handler and calls `connection.close()` (which is idempotent and terminal).
- **CLI wire-up:** `src/cli/index.ts`'s `worker` subcommand calls `runWorker(deps)` which calls `startWorker()`. Errors are printed to stderr; exit code 1.
- **Tests:** `src/__sanity__/worker.test.ts` — 4 cases: whoami called on startup; `run.start` produces the 4-message flow in order with correct shapes; `gate.decided` is a no-op (no outbound messages within 100ms); `stop()` closes the WS so the server sees `"close"`.
- **Out of scope (intentional):**
  - Run reclamation via `whoami`/`getRun` on reconnect — task 23.
  - Real research execution via Claude Agent SDK — tasks 09, 10.
  - Zod validation of stage outputs — task 10.
  - Handling `run.cancel` beyond logging — task 24.
