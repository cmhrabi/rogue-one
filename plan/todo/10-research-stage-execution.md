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
