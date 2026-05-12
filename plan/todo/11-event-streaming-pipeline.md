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
