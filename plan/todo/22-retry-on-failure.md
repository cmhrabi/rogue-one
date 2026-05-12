# 22 — Auto-retry-once on stage failure

**Phase:** 3
**Depends on:** 14

## Goal

Every stage gets one automatic retry with failure context appended to the prompt. If retry also fails, run moves to `awaiting_human_intervention`.

## Scope

- `src/util/retry.ts` exposing `withStageRetry(stageFn, input, ctx)` which:
  - Catches any error from `stageFn`.
  - Sends `stage.failed` (requires real stage UUID — fetched by orchestrator pre-stage and threaded through).
  - Retries `stageFn` once with an `additionalContext` field that contains the prior error message + a hint for the model.
  - On second failure, returns a sentinel that tells the orchestrator to transition the run to `awaiting_human_intervention` and stop the pipeline.
- Orchestrator (task 14) wraps every stage call with `withStageRetry`.

## Acceptance criteria

- Unit test: stage throws once → retry happens with `additionalContext` populated → second call succeeds → pipeline continues.
- Unit test: stage throws twice → orchestrator stops, emits the human-intervention transition.

## Notes

- `awaiting_human_intervention` is a run status — verify it's allowed by `canTransition` from the failing stage's current status. If yavin-iv requires `run.status` not be sent by workers, use whatever signal the contract defines instead (re-read contract §6 if uncertain). The full flow lands in task 25.
- Don't retry indefinitely — the bound is exactly one retry per stage per run.
