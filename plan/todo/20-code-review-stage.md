# 20 — Code review stage

**Phase:** 3
**Depends on:** 16, 19

## Goal

Critic reviews the diff; if `revise`, the coder addresses comments once.

## Scope

- `src/pipeline/stages/codeReview.ts`:
  ```ts
  async function runCodeReviewStage(input: {
    diff: string;
    plan: PlanOutput;
    testOutput: string;
    reviewer: Reviewer;
    cwd: string;
    onEvent: (e: AgentEvent) => void;
    abortSignal: AbortSignal;
  }): Promise<CodeReviewOutput>;
  ```
- Calls `reviewer.reviewCode(...)`.
- If `decision === "revise"` and not already revised, the orchestrator re-invokes the **code stage** (not the review) with the comments threaded in as user input, then re-runs code review. One round, like plan review.
- Validate with `CodeReviewOutput` zod.

## Acceptance criteria

- Unit test: `revise` triggers exactly one code re-run; `accept` does not.
- Severities ∈ `{info, suggestion, issue, blocker}` are preserved through the pipeline to yavin-iv.

## Notes

- `blocker` severity comments do not automatically terminate the run — the human at the `pre_pr` gate makes that call.
- Don't push or open the PR here.
