# 17 — Plan review stage

**Phase:** 3
**Depends on:** 15, 16

## Goal

Produce a validated `PlanReviewOutput` and feed regeneration when the critic asks for revisions (bounded to one round in MVP).

## Scope

- `src/pipeline/stages/planReview.ts`:
  ```ts
  async function runPlanReviewStage(input: {
    run: Run; ticket: Ticket;
    plan: PlanOutput;
    research: ResearchOutput;
    reviewer: Reviewer;
    onEvent: (e: AgentEvent) => void;
    abortSignal: AbortSignal;
  }): Promise<PlanReviewOutput>;
  ```
- Calls `reviewer.reviewPlan(...)`.
- If `decision === "revise"` and a revision has not yet been attempted in this run, the orchestrator (task 14) re-invokes the plan stage with `revisionFeedback` set to `critique` (or `revisedPlan`'s summary), then runs plan_review again. After one round, the result ships to the gate regardless.
- Output validated with `PlanReviewOutput` zod.

## Acceptance criteria

- Unit test: critic returns `revise` → orchestrator re-runs plan once → second plan_review's decision is passed through.
- Unit test: critic returns `accept` → no re-run.

## Notes

- The "one revision round" bound is per the open question in implementation-plan.md §17. Encode it as a constant in the orchestrator so it's easy to lift later.
