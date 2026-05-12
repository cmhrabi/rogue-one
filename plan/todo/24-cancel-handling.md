# 24 — `run.cancel` mid-stage

**Phase:** 4
**Depends on:** 08, 14

## Goal

When yavin-iv sends `run.cancel`, the active SDK session aborts promptly, a final event is recorded, and the pipeline returns without proceeding.

## Scope

- Orchestrator holds an `AbortController` per active run.
- On `run.cancel` for a known runId:
  1. `controller.abort(new RunCancelledError(...))`.
  2. Pipeline catches, emits a `stage.failed` (or appropriate terminal event) with reason `cancelled`.
  3. Worktree teardown remains a no-op (humans inspect post-hoc).
- Cancel arriving after a run has already terminated is a no-op.

## Acceptance criteria

- Integration test: cancel during research aborts the SDK call within ~2s.
- Unit test: cancel mid-`awaitGate` resolves the gate promise as a rejection that the orchestrator handles cleanly.

## Notes

- Don't transition `run.status` from the worker — yavin-iv handles cancel-side state.
- The SDK must support `AbortSignal`; if not, ensure session wrapper polls and exits at next message boundary.
