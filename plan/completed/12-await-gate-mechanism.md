# 12 — `awaitGate` mechanism

**Phase:** 2
**Depends on:** 04, 10

## Goal

`src/pipeline/gates.ts` exposes `awaitGate(runId, gateKind): Promise<GateDecided>` which sends `gate.await` and resolves only when yavin-iv sends matching `gate.decided`.

## Scope

- API:
  ```ts
  interface GateDecided {
    decision: "approved" | "rejected" | "regenerate";
    feedback?: string;
  }

  function awaitGate(args: {
    connection: YavinConnection;
    runId: string;
    gateKind: GateKind;
    payload: unknown;
    abortSignal?: AbortSignal;
  }): Promise<GateDecided>;
  ```
- Implementation:
  - Sends `gate.await` immediately on call.
  - Subscribes to the connection's message stream; resolves on the first matching `(runId, gateKind)` `gate.decided`.
  - Rejects if `run.cancel` arrives for the same run.
  - Rejects on `abortSignal`.
- Caller is responsible for routing: if `decision === "regenerate"`, re-run the stage; `rejected`, terminate the pipeline; `approved`, proceed.

## Acceptance criteria

- Unit test with a fake connection verifies the three resolution paths (decided, cancelled, aborted).
- Manual: research stage → `gate.await` → approve in dashboard → promise resolves with `approved`.

## Notes

- Don't transition run status from rogue-one — yavin-iv owns the state machine on gate decisions.
- The promise must clean up its listener on resolve/reject to avoid leaks across many gates per run.

## Completion notes — 2026-05-12

### Files changed
- `src/pipeline/gates.ts` (replaced stub) — `awaitGate`, `GateDecided`, `GateCancelledError`, `GateAbortedError`.
- `src/pipeline/gates.test.ts` (new) — 6 unit tests with an in-process `FakeConnection`.

### Deviations from spec
- The plan said "attach listener first, then send" to avoid races. Done — `connection.on("message", handler)` runs before `connection.send(...)`.
- Pre-aborted signal short-circuits before the `gate.await` send (so a run cancelled before the call doesn't pollute the outbox).
- `feedback` is only included on the resolved object when the server actually sent one (omits `feedback: undefined` to match `exactOptionalPropertyTypes`-friendly callers).

### Tests added
- `src/pipeline/gates.test.ts` — approved path; foreign runId/gateKind ignored; cancel path; foreign cancel ignored; abort during wait; pre-aborted signal does not send.

### Follow-ups
- The orchestrator (task 14) will be the primary caller — it owns the per-run `AbortController` that propagates `run.cancel` into both the stage and the gate.

### Verification
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — 42 passing (36 prior + 6 new).
