# 02 — `@cmhrabi/yavin-protocol` dependency

**Phase:** 1
**Depends on:** 01

## Goal

Wire up `@cmhrabi/yavin-protocol` from GitHub Packages so rogue-one shares wire types and zod schemas with yavin-iv.

## Scope

- Add `.npmrc` at repo root:
  ```
  @cmhrabi:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
  ```
- Document `GITHUB_TOKEN` (PAT with `read:packages`) requirement in `README.md`.
- `pnpm add @cmhrabi/yavin-protocol`.
- Create `src/protocol.ts` that re-exports the types and schemas rogue-one will use:
  ```ts
  export type {
    Run, Stage, Event, RepoConfig, Ticket,
    RunStatus, StageKind, StageStatus,
    GateKind, GateDecision,
    WorkerToServer, ServerToWorker,
  } from "@cmhrabi/yavin-protocol";

  export {
    RUN_STATUSES, VALID_TRANSITIONS, canTransition,
    STAGE_KINDS, STAGE_STATUSES,
    GATE_KINDS, GATE_DECISIONS,
    ResearchOutput, PlanOutput, CodeOutput, CodeReviewOutput, PrOutput,
  } from "@cmhrabi/yavin-protocol";
  ```
- A trivial sanity test: a `src/__sanity__/protocol.test.ts` that imports `canTransition` and asserts `canTransition("pending","researching")` is true.

## Acceptance criteria

- `pnpm install` resolves the package successfully when `GITHUB_TOKEN` is set.
- `import { canTransition } from "./protocol"` typechecks.
- Sanity test passes (use any minimal runner — `node --test` is fine, no jest needed).

## Notes

- Do not vendor or copy types. Always import from the package.
- If the package version ever needs to change, do it in a dedicated PR — never silently bump.

## Implementation notes (2026-05-12)

- **Resolved version:** `@cmhrabi/yavin-protocol@0.0.1`.
- **Auth gotcha:** the default `gh auth login` scopes (`gist, read:org, repo, workflow`) do NOT include `read:packages`. Install will 403. Fix once with:
  ```sh
  gh auth refresh -s read:packages
  export GITHUB_TOKEN=$(gh auth token)
  pnpm install
  ```
  The README "Setup" section now documents this.
- **`src/protocol.ts` surface re-exported** (verified against the installed `.d.ts`):
  - Types: `Run, Stage, Event, EventInput, AgentMessage, AgentMessageInput, AgentRole, RepoConfig, Ticket, RelatedItem, RunStatus, StageKind, StageStatus, TicketProvider, GateKind, GateDecision, WorkerToServer, ServerToWorker`.
  - Values: `RUN_STATUSES, VALID_TRANSITIONS, canTransition, TERMINAL_STATUSES, AWAITING_GATE_STATUSES, STAGE_KINDS, STAGE_STATUSES, TICKET_PROVIDERS, GATE_KINDS, GATE_DECISIONS, AGENT_ROLES, ResearchOutput, PlanOutput, PlanReviewOutput, CodeOutput, CodeReviewOutput, PrOutput`.
  - The task originally listed `ResearchOutput, PlanOutput, CodeOutput, CodeReviewOutput, PrOutput`. The published package also has `PlanReviewOutput`, `PlanStep`, `CodeFileChange`, `CodeReviewComment` — `PlanReviewOutput` is re-exported (matches `plan_review` in `STAGE_KINDS`); the rest can be added if needed.
- **Sanity test path:** `src/__sanity__/protocol.test.ts`. Five assertions (transition allow/deny, `RUN_STATUSES` content, `STAGE_KINDS` shape, `ResearchOutput.parse`). Runs under `pnpm test`.
- **Note for `ServerToWorker.kind === "ping"`:** the published `ServerToWorker` includes `{ kind: "ping" }` (no `runId`). The connection module handles it; downstream consumers never see ping messages.
