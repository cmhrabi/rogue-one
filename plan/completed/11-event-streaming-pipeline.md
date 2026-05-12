# 11 — Event streaming pipeline

**Phase:** 2
**Depends on:** 05, 08, 10

## Goal

Every SDK message from `runSession()` is fanned out to yavin-iv as `event.append` (and `agent.message` where applicable), with correct `runId` and `stageId` plumbing.

## Scope

- `src/worker/eventEmitter.ts`:
  ```ts
  class EventEmitter {
    constructor(connection: YavinConnection, restClient: YavinClient);
    bindRun(runId: string): RunEventSink;
  }

  interface RunEventSink {
    setCurrentStageUuid(uuid: string | null): void;
    log(message: string, extra?: unknown): void;
    toolCall(name: string, args: unknown): void;
    toolResult(name: string, ok: boolean, result: unknown): void;
    agentMessage(msg: { role; content; usage; usdCost; modelId }): void;
  }
  ```
- `RunEventSink.agentMessage` requires a real stage UUID — if none set yet, queue until one is provided.
- All other events pass `stageId: null` if no UUID is available (allowed per contract §5).
- After `stage.started` is sent, fetch `GET /api/runs/{id}` once to learn stage UUIDs and call `setCurrentStageUuid(...)` for the active stage kind.
- The SDK `onEvent` callback in `runSession()` maps SDK message kinds to the sink methods.

## Acceptance criteria

- During a research run, the yavin-iv event log shows interleaved `log`, `tool_call`, `tool_result`, `message` rows.
- `agent.message` records have `stageId` populated (because UUID lookup happens once per stage).
- Sequence numbers are continuous and assigned server-side (no gaps from client).

## Notes

- Bound the buffered `agent.message` queue. If it grows past N (say 256) before a stage UUID arrives, log critical and drop the oldest — UUID lookup should be near-instant in practice.
- Don't try to dedupe — yavin-iv's `seq` allocation handles ordering.

## Completion notes — 2026-05-12

### Files changed
- `src/worker/eventEmitter.ts` (new) — `EventEmitter` factory + `RunEventSink` interface + `AgentMessageRecord` shape.
- `src/worker/eventEmitter.test.ts` (new) — 8 unit tests covering routing, buffering, queue cap, UUID transitions.

### Deviations from spec
- The plan suggested the EventEmitter would do the `getRun()` UUID lookup itself. Implementation keeps that on the worker (which already has the `YavinClient` instance) — the emitter just exposes `setCurrentStageUuid(uuid)`. The `restClient` constructor argument is kept for future moves of stage-discovery logic into the emitter without a breaking API change.
- `usdCost` is plumbed but always `undefined` from `fromAgentEvent` (per-turn USD is not computed; only end-of-session totals from task 08). Callers that have a USD figure can still call `sink.agentMessage({ ..., usdCost })` directly.
- `system`/`result`/`raw` events all emit `log` (per the plan) — content payload is `{ message, extra? }`.

### Tests added
- `src/worker/eventEmitter.test.ts` — pre-UUID immediate sends; buffer→flush; queue overflow drops oldest; post-UUID immediate sends; UUID-null→UUID-new resumption; `fromAgentEvent` routing for each kind.

### Follow-ups
- Task 10 wires this into the worker (`startWorker` constructs an `EventEmitter`; each `run.start` calls `bindRun` then `getRun` for the UUID then `setCurrentStageUuid`).
- Task 26 will populate per-turn `usdCost` once the cost tracker exists.

### Verification
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — 50 passing (42 prior + 8 new).
