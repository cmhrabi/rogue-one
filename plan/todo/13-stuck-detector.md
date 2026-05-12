# 13 — Stuck detector

**Phase:** 2
**Depends on:** 08, 11

## Goal

If a running stage produces no events for `ROGUE_ONE_STUCK_TIMEOUT_MS` (default 5 min), abort the SDK session and surface it as a stage failure.

## Scope

- `src/util/stuckDetector.ts`:
  ```ts
  class StuckDetector {
    constructor(timeoutMs: number, onStuck: () => void);
    poke(): void;       // call on every event
    start(): void;
    stop(): void;
  }
  ```
- Wired into the research stage: every event from `runSession()` calls `poke()`. The session's `AbortController` is aborted when `onStuck` fires.
- The resulting `AbortError` propagates as a stage failure with reason `"stuck: no events for Xms"`.

## Acceptance criteria

- Unit test (fake timers) verifies `onStuck` fires only after the timeout with no `poke()` calls and is reset by `poke()`.
- Manual: temporarily set timeout to 5s, run a stage that idles, observe abort + stage failure event.

## Notes

- The detector watches outbound events, not inbound from yavin. The user-facing "no progress" definition is "no new event for the dashboard."
- Don't auto-restart on stuck — task 22 owns retry policy.
