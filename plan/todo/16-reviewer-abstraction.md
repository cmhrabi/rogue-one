# 16 — Reviewer abstraction

**Phase:** 3
**Depends on:** 08

## Goal

`src/agents/reviewer.ts` defines the `Reviewer` interface and `ClaudeAdversarialCritic` default implementation. Selected at runtime via `process.env.REVIEWER`.

## Scope

- Interface:
  ```ts
  interface Reviewer {
    reviewPlan(input: { plan: PlanOutput; ticket: Ticket; research: ResearchOutput }): Promise<PlanReviewOutput>;
    reviewCode(input: { diff: string; plan: PlanOutput; testOutput: string }): Promise<CodeReviewOutput>;
  }
  ```
- `ClaudeAdversarialCritic`:
  - Uses an adversarial prompt (`src/agents/prompts/critic.md`) — challenge assumptions, find missed edge cases, flag risk.
  - `reviewPlan` uses read-only tools and asks for `{ critique, revisedPlan?, decision }`.
  - `reviewCode` uses Read/Grep/Bash (for inspecting tests), asks for `{ comments, summary, decision }`.
- Factory `getReviewer(env): Reviewer` keyed on `REVIEWER` env (default `claude-adversarial`). Unknown values throw at startup.

## Acceptance criteria

- `getReviewer({ REVIEWER: undefined })` returns `ClaudeAdversarialCritic`.
- Unit test with a faked SDK confirms both methods return shapes matching the zod schemas.

## Notes

- Don't build GPT5Reviewer or others now — the interface is the deliverable.
- The critic prompt should explicitly forbid agreeing for the sake of agreement.
