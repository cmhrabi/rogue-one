# 14 — Pipeline orchestrator

**Phase:** 3 (Full pipeline)
**Depends on:** 10, 11, 12

## Goal

`src/pipeline/orchestrator.ts` drives the 6-stage state machine on top of single-stage runners and `awaitGate`.

## Scope

- API:
  ```ts
  async function runPipeline(args: {
    run: Run;
    repoConfig: RepoConfig;
    ticket: Ticket;
    connection: YavinConnection;
    rest: YavinClient;
    abortSignal: AbortSignal;
  }): Promise<void>;
  ```
- Sequence:
  ```
  research → awaitGate(post_research)
    → plan → plan_review → awaitGate(post_plan)
    → code → code_review → awaitGate(pre_pr)
    → pr
  ```
- For each stage:
  1. Send `stage.started`.
  2. Look up the stage UUID via `rest.getRun(run.id)` and inform the `EventEmitter`.
  3. Run the stage function (each landed in its own task: 15, 17, 19, 20, 21).
  4. Validate the output (Zod) and send `stage.completed`.
  5. Where required, `gate.await` then proceed based on `GateDecided`:
     - `approved` → next stage
     - `regenerate` → re-run the stage (only the stage that produced the artifact being gated). Pass `feedback` into the stage as additional input.
     - `rejected` → return (yavin-iv already moved the run server-side).
- Cancellation: an `AbortError` in any stage propagates and aborts subsequent stages.

## Acceptance criteria

- Happy-path integration test (with all stage functions stubbed to return canned outputs) walks all 6 stages and 3 gates.
- A `regenerate` decision causes exactly one re-run of the gated stage with feedback included.
- A `rejected` decision returns without invoking later stages.

## Notes

- Retry-on-failure is task 22; for this task, failures bubble up.
- Don't share mutable state across stages other than a typed `PipelineContext` (`stages`, `ticket`, `repoConfig`, `branch`, `cwd`).
