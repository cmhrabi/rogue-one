# 15 — Plan stage

**Phase:** 3
**Depends on:** 08, 11, 14

## Goal

Produce a validated `PlanOutput` from the research brief.

## Scope

- `src/agents/prompts/planner.md` — system prompt:
  - Input: research brief + ticket + (optional) reviewer critique on regenerate.
  - Output: JSON matching `PlanOutput` (`summary`, `steps[{title,description,files,notes?}]`).
  - Read-only tools.
- `src/pipeline/stages/plan.ts`:
  ```ts
  async function runPlanStage(input: {
    run: Run; ticket: Ticket; repoConfig: RepoConfig;
    research: ResearchOutput;
    revisionFeedback?: string;
    onEvent: (e: AgentEvent) => void;
    abortSignal: AbortSignal;
  }): Promise<PlanOutput>;
  ```
- `allowedTools: ["Read","Grep","Glob"]`. No web.
- Validate with `PlanOutput` zod schema before returning.

## Acceptance criteria

- Given a hand-written research brief and a ticket fixture, the stage returns a valid `PlanOutput`.
- Regenerate path: `revisionFeedback` text appears in the user message.

## Notes

- Keep planner read-only — coding happens in task 19.
- Plan schema must match `@cmhrabi/yavin-protocol`'s exported zod. Do not redefine locally.
