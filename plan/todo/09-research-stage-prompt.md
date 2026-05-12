# 09 — Research stage system prompt

**Phase:** 2
**Depends on:** 01

## Goal

`src/agents/prompts/researcher.md` containing the system prompt for the research stage.

## Scope

- A clear system prompt that:
  - Frames the agent as a senior engineer doing pre-implementation research on a ticket.
  - Lists the allowed tools (`Read, Grep, Glob, WebSearch, WebFetch`) and forbids edits.
  - Demands a final answer matching `ResearchOutput` shape: `{ brief, citations[], notes? }`.
  - Requires citations to include real URLs (no fabrication).
  - Sets expectations: ~300–800 word `brief`, code references with `path:line`.
- A loader: `src/agents/prompts/index.ts` exports `loadPrompt(name): string` reading from the `prompts/` dir at runtime, with bundling considered (use `import.meta.url` resolution under ESM).

## Acceptance criteria

- `loadPrompt("researcher")` returns the prompt body.
- Prompt instructs the model to emit JSON conformant with `ResearchOutput`.

## Notes

- Keep the prompt in markdown so it's easy to diff later.
- Don't include yavin-iv internals — the prompt should make sense to a fresh Claude session.
