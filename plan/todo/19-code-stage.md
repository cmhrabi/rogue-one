# 19 — Code stage

**Phase:** 3
**Depends on:** 08, 11, 15, 18

## Goal

Inside the run's worktree, execute the plan with the full Claude Agent toolset, produce a diff, and emit a validated `CodeOutput`.

## Scope

- `src/agents/prompts/coder.md` — system prompt: implement the plan, run tests, fix failures.
- `src/pipeline/stages/code.ts`:
  ```ts
  async function runCodeStage(input: {
    run: Run; plan: PlanOutput; cwd: string; branch: string;
    onEvent: (e: AgentEvent) => void;
    abortSignal: AbortSignal;
  }): Promise<CodeOutput>;
  ```
- Calls `runSession()` with `allowedTools` = full set (Read, Write, Edit, Bash, Grep, Glob).
- After the session ends, derive `files[]` from `git diff` against the base branch (parse via `simple-git`), with `status ∈ {added, modified, deleted, renamed}` and `diff` a unified hunk per file.
- Captures test output (last `Bash` invocation matching a configured test command, or `npm test` heuristic) into `summary`.
- Validate with `CodeOutput` zod.

## Acceptance criteria

- On a sandbox repo, plan → code stage produces a non-empty `files[]` with diffs that apply cleanly.
- If tests fail, the stage still completes and `summary` mentions the failure (the human reviews at the gate).

## Notes

- The orchestrator sets up the worktree before invoking this stage. Do not setup/teardown inside the stage.
- Don't push the branch here — that's the PR stage.
