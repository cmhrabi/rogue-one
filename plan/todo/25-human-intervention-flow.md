# 25 — `awaiting_human_intervention` flow

**Phase:** 4
**Depends on:** 22

## Goal

After two failed attempts at a stage, the run lands in `awaiting_human_intervention` cleanly, with enough context for a human to recover.

## Scope

- Confirm with yavin-iv contract whether the worker triggers this transition explicitly (via `run.status`) or whether `stage.failed` after retry-exhaustion is sufficient. Update task description here if the contract dictates one path.
- The orchestrator, on retry-exhaustion:
  - Emits a final `event.append` of kind `log` summarizing both attempts (error messages, stage name).
  - Sends `stage.failed` with the second error.
  - If explicit transition required: `run.status` to `awaiting_human_intervention` (validate via `canTransition`).
  - Exits the pipeline.
- Verify the dashboard displays the run in an actionable state.

## Acceptance criteria

- Forcing a stage to fail twice produces a run in `awaiting_human_intervention` with the failure log visible in yavin-iv.
- The worker does not pick the run up again automatically; only human action (via dashboard) moves it forward.

## Notes

- Don't auto-retry a third time anywhere.
- Don't keep the run's resources (worktree, etc.) tied up in this worker — release everything except the worktree files themselves.
