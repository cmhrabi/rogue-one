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
