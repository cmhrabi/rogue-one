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

## Completion notes — 2026-05-12

### Files changed
- `src/agents/prompts/researcher.md` (new) — system prompt body.
- `src/agents/prompts/index.ts` (new) — `loadPrompt(name)` with module-level cache, reads `<name>.md` via `fileURLToPath(import.meta.url)`.
- `src/agents/prompts/index.test.ts` (new) — three tests: marker substrings, cache identity, unknown-name throws.
- `package.json` (modified) — `build` now runs `tsc -p . && mkdir -p dist/agents/prompts && cp src/agents/prompts/*.md dist/agents/prompts/` so the `.md` files ship to `dist/`.

### Deviations from spec
- Initial `cp -R` copied `.ts` files into `dist/`. Tightened to `*.md` only.

### Tests added
- `src/agents/prompts/index.test.ts` — verifies marker substrings (`citations`, `path:line`, `brief`, `ResearchOutput`), cache, and unknown-name guard.

### Follow-ups
- Add more prompt names to `PromptName` + `KNOWN_PROMPTS` whitelist when tasks 15 / 17 / 19 / 20 land.

### Verification
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — 28 passing.
- `pnpm build` — `dist/agents/prompts/` contains `index.js`, `index.js.map`, `researcher.md`.
