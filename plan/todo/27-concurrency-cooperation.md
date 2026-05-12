# 27 — Concurrency cooperation with yavin-iv

**Phase:** 4
**Depends on:** 05, 14

## Goal

The worker never starts a run on its own initiative — it only acts on `run.start`. Multiple concurrent runs are supported up to yavin-iv's per-worker cap.

## Scope

- Audit the worker loop: remove any code path that initiates work without `run.start` (the only exception is `run.claim` for explicit resume after restart, task 23).
- Support multiple concurrent pipelines:
  - A `Map<runId, PipelineHandle>` tracks active runs.
  - `run.start` for an already-tracked runId is logged and ignored (or treated as a resume hint).
  - Each pipeline owns its own `AbortController`, EventEmitter binding, and worktree.
- The worker advertises a label (`ROGUE_ONE_WORKER_LABEL`) on connect (if the contract supports it via query param or first message) so the dashboard can show which machine is busy.

## Acceptance criteria

- Two runs started in quick succession both proceed to research in parallel.
- Killing one run's pipeline doesn't affect the other.
- The worker never POSTs `/api/runs` on its own.

## Notes

- Concurrency cap is yavin-iv's call — the worker should accept whatever number of concurrent runs yavin-iv hands it.
- Don't add local rate-limiting; if needed, propose adding it to yavin-iv side instead.
