# 08 — Claude Agent SDK wrapper

**Phase:** 2 (Research stage real)
**Depends on:** 04

## Goal

`src/agents/session.ts` exposes a single `runSession()` function that owns Claude Agent SDK lifecycle, tool restrictions, event forwarding, and abort.

## Scope

- `pnpm add @anthropic-ai/claude-agent-sdk`.
- API:
  ```ts
  interface SessionConfig {
    systemPrompt: string;
    cwd: string;
    allowedTools: string[];
    maxTurns?: number;            // default 50
    abortSignal?: AbortSignal;
    onEvent: (e: AgentEvent) => void;   // every SDK message
  }

  interface SessionResult {
    finalAssistantText: string;
    totals: { inputTokens: number; outputTokens: number; usd: number };
  }

  async function runSession(cfg: SessionConfig, userMessage: string): Promise<SessionResult>;
  ```
- Iterates the SDK `query()` async generator; forwards each message to `onEvent`.
- Tracks token totals as messages arrive (so `agent.message` records can later be populated).
- `abortSignal` aborts the underlying SDK session promptly.
- Throws `AgentSessionError` with a useful `cause` when the SDK errors.

## Acceptance criteria

- Unit test with a faked SDK iterable verifies:
  - Each message produces an `onEvent` call.
  - Token totals accumulate.
  - Aborting via `AbortController` resolves with a thrown abort error.
- `pnpm typecheck` + lint pass.

## Notes

- Don't bake stage-specific logic into the wrapper. Stages own their prompts and tool lists; the wrapper is a pipe.
- USD calculation can use a simple per-model price table for now — wire real cost tracking in task 26.

## Completion notes — 2026-05-12

### Files changed
- `package.json` (modified) — added `@anthropic-ai/claude-agent-sdk ^0.2.139`.
- `src/agents/session.ts` (new) — `runSession`, `AgentEvent`, `SessionConfig`, `SessionResult`, `AgentSessionError`, `PRICE_TABLE`.
- `src/agents/session.test.ts` (new) — 8 unit tests, all using DI'd `queryFn` (no real SDK calls).

### Deviations from spec
- The SDK's actual `query()` signature is `query({ prompt, options })` (not `(cfg)`), and it returns a `Query` (an `AsyncGenerator<SDKMessage>`). The wrapper iterates the generator and maps SDK shapes to a smaller normalized `AgentEvent` shape so the rest of the codebase doesn't depend on `BetaMessage`/`SDKMessage`.
- Each assistant message can carry multiple content blocks (text + tool_use), so `normalize()` fans out one SDK message into 0..N `AgentEvent`s. Tool_use_id is preserved.
- Token totals: prefer the terminal `result.usage`; fall back to the **max** per-message usage seen (per-message usage is monotonically increasing per Anthropic's API). The plan said "accumulate" — using max-of-cumulative is what the SDK actually emits.
- `cause` and `code` fields added to `AgentSessionError` (plan suggested `cause` only). `code` is `"ABORTED" | "SDK_ERROR"` so callers can suppress aborts cleanly.
- `claude-future-x-1` and other unknown models fall back to Sonnet pricing (no logger.warn here — the wrapper has no logger; task 26 will revisit).

### Tests added
- `src/agents/session.test.ts` — onEvent order; per-message-usage fallback; tool_use payload; tool_result payload; pre-iteration abort; mid-iteration abort; SDK throw wrapping; unknown-model pricing fallback.

### Follow-ups
- Task 26 owns real cost tracking — replace `PRICE_TABLE` with a live source or a richer model registry.
- The SDK has a peer dependency on `zod@^4` but yavin-protocol pins `zod@^3`. The mismatch is harmless because rogue-one only consumes schemas — the SDK doesn't expose zod-typed values to callers — but if the SDK starts exporting zod types we'll need to align.

### Verification
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — 36 passing (28 prior + 8 new).
