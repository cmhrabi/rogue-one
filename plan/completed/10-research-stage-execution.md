# 10 — Research stage execution

**Phase:** 2
**Depends on:** 08, 09

## Goal

Replace the stub research handler from task 05 with a real Claude-driven research stage that produces a validated `ResearchOutput`.

## Scope

- `src/pipeline/stages/research.ts` with:
  ```ts
  async function runResearchStage(input: {
    run: Run;
    ticket: Ticket;
    repoConfig: RepoConfig;
    onEvent: (e: AgentEvent) => void;
    abortSignal: AbortSignal;
  }): Promise<ResearchOutput>;
  ```
- Internals:
  - Load the researcher prompt.
  - Build the user message from ticket fields (`id`, `title`, `url`, `description`, plus any instructions).
  - Call `runSession()` with `allowedTools: ["Read","Grep","Glob","WebSearch","WebFetch"]`, `cwd: repoConfig.repoPath`.
  - Extract the structured output from the final assistant message. Expect JSON; tolerate JSON inside a code fence.
  - Validate with `ResearchOutput` zod schema. On failure, throw `StageOutputInvalidError` with the validation issues.
- The worker entry (task 05) is rewired so `run.start` calls this stage, then `gate.await('post_research')` with the validated output.

## Acceptance criteria

- An end-to-end run against a dev yavin-iv + real ticket produces a `gate.await` whose payload validates as `ResearchOutput`.
- If the model returns malformed JSON, `stage.failed` is emitted (real stage UUID will be wired in task 22's retry path — for now, log the failure).

## Notes

- Don't yet handle retry — task 22 owns that. Just throw on validation failure.
- The ticket data still comes inside `run.start` (see contract §5). No ticket lookup endpoint use yet.

## Completion notes — 2026-05-12

### Files changed
- `src/pipeline/stages/research.ts` (replaced stub) — `runResearchStage`, `StageOutputInvalidError`, `extractJsonObject`, allowed-tools list.
- `src/pipeline/stages/research.test.ts` (new) — 9 unit tests with `runSessionFn` injection.
- `src/worker/index.ts` (modified) — `handleRunStart` now drives the real research stage:
  1. `stage.started` + initial log event.
  2. `client.getRun()` with 100/300/900 ms retries to find the real research stage UUID; `sink.setCurrentStageUuid(uuid)` once known.
  3. `runResearchStage()` with the per-run `AbortController.signal`.
  4. `stage.completed` carrying the validated `ResearchOutput`, then `awaitGate({gateKind:"post_research"})`.
  - `StageOutputInvalidError` → `event.append` ("research output invalid") + `stage.failed` with the real UUID.
  - `GateCancelledError` / `GateAbortedError` / `controller.signal.aborted` → log and exit cleanly (no `stage.completed`).
  - Per-run `AbortController` map; `run.cancel` aborts the in-flight handler; `stop()` aborts all.
- `src/__sanity__/worker.test.ts` (modified) — replaced the stub-flow assertion with the new flow; added two new tests: stage.failed on invalid output, run.cancel aborts in-flight research.
- `StartWorkerOptions` gained an optional `runSessionFn` for test injection (threaded through to `runResearchStage`).
- `ANTHROPIC_API_KEY` is checked at startup but only warned about; failure is deferred to the first `runSession()` call (the SDK enforces it).

### Deviations from spec
- The plan suggested filtering out `status === "superseded"` stages in the UUID lookup; the `StageStatus` union doesn't include `"skipped"`, so the filter was dropped — just pick the first stage matching `kind`. If multiple research attempts ever land in one run (task 22) we'll revisit.
- `stage.failed` is also emitted for non-validation errors (any throw during the handler) when a UUID is known, so transient failures don't silently hang the run.
- The in-flight log event ("worker received run …") fires via `sink.log` (not direct `connection.send`), so the existing test continues to see an early `event.append` and the eventEmitter routes consistently.

### Tests added
- `src/pipeline/stages/research.test.ts` — raw JSON, fenced JSON, narration around JSON, garbage → throws, missing-`brief` → throws, dependency propagation, `extractJsonObject` direct cases.
- `src/__sanity__/worker.test.ts` — replaced the stub-flow assertion with the real-flow assertion (`validResearch` injected); added `stage.failed when research output invalid`; added `run.cancel aborts the in-flight research stage`.

### Follow-ups
- Task 22 owns retry-on-failure (currently `StageOutputInvalidError` → one-shot `stage.failed`).
- Task 23 owns reconnect/replay (currently the in-flight `runResearchStage` does not survive a worker restart).
- The orchestrator (task 14) will move the gate-decision dispatch out of `handleRunStart` and into a state machine that runs the next stage on `approved` / re-runs research on `regenerate`.

### Verification
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — 61 passing (50 prior + 9 stage + 2 worker rewires).
- `pnpm build` — `dist/` rebuilds cleanly with `researcher.md` copied in.
