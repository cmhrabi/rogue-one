# 26 — Per-stage cost tracking

**Phase:** 4
**Depends on:** 08, 11

## Goal

Every `agent.message` sent to yavin-iv carries accurate token counts, model id, and USD cost. Stage totals surface in the dashboard.

## Scope

- `src/util/cost.ts` with a per-model price table (input/output USD per 1M tokens) and `computeCost(modelId, inputTokens, outputTokens)`.
- `runSession` (task 08) populates per-message `usage` and `usdCost` from SDK output where available; falls back to `computeCost` otherwise.
- `agent.message` outbound shape includes:
  - `role`, `content`
  - `usage: { inputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens? }`
  - `modelId`
  - `usdCost` (number)
- Stage runner accumulates a running total per stage; on `stage.completed`, attach a `costSummary` to the structured output's `notes`/`summary` field (without breaking zod). Or emit a final `event.append` of kind `log` with the summary.

## Acceptance criteria

- After a real run, the yavin-iv UI shows non-zero USD per stage.
- Price table is centralized — changing a price doesn't require edits across stages.

## Notes

- Don't invent prices — pull current values from Anthropic's published rates and cite the source in a comment.
- Cache token discounts: if the SDK reports cache read tokens, apply the discounted rate.
