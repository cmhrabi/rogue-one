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
