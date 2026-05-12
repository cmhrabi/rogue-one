# 23 — Reconnect & replay correctness

**Phase:** 4 (Reliability)
**Depends on:** 04, 11, 14

## Goal

Network blips, worker restarts, and yavin-iv outages are recoverable without losing events or progressing the wrong stage.

## Scope

- On worker boot:
  1. Connect WS.
  2. After whoami succeeds, fetch any runs the worker should resume. Either:
     - rely on yavin-iv re-pushing `run.start` for runs still owned by this worker (preferred — verify against yavin-iv behavior), or
     - call `run.claim` for known pending-but-owned runs.
  3. For each resumed run, `GET /api/runs/{id}` to recover stage UUIDs and the event log tail.
  4. Resume mid-stage if `status` is a `*ing` value; just wait if `awaiting_*_approval`.
- On WS close mid-run:
  - In-flight SDK session keeps running.
  - Outbox buffers messages.
  - On reconnect, flush in order. Server allocates `seq` — no duplicates expected; if seen, log and move on.
- Idempotency: `stage.started` and `stage.completed` are safely re-sendable; verify by sending each twice in tests.

## Acceptance criteria

- Integration test (yavin-iv test instance): kill the worker mid-research, restart, run resumes (or restarts the stage idempotently) without losing prior events.
- Unit test: outbox preserves message order through close → open cycles.
- Worker survives a 10-second WS outage with no data loss.

## Notes

- If the contract's `run.claim` semantics differ from what's assumed, prefer the contract — re-read context.md §"Reconnection recipe".
- Don't try to mutate `seq` on the client. The server owns it.
