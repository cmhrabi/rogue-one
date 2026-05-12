import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  awaitGate,
  GateAbortedError,
  GateCancelledError,
} from "./gates.js";
import type { YavinConnection } from "../worker/connection.js";
import type { ServerToWorker, WorkerToServer } from "../protocol.js";

/**
 * Fake YavinConnection that satisfies the shape awaitGate needs: an EventEmitter
 * with `on`/`off` for "message" events plus a `.send()` recorder.
 */
class FakeConnection extends EventEmitter {
  readonly sent: WorkerToServer[] = [];
  send(msg: WorkerToServer): void {
    this.sent.push(msg);
  }
  emitMessage(msg: ServerToWorker): void {
    this.emit("message", msg);
  }
}

function fakeConn(): YavinConnection {
  return new FakeConnection() as unknown as YavinConnection;
}

test("awaitGate: sends gate.await and resolves on matching gate.decided", async () => {
  const conn = fakeConn() as unknown as FakeConnection;
  const promise = awaitGate({
    connection: conn as unknown as YavinConnection,
    runId: "run-1",
    gateKind: "post_research",
    payload: { brief: "x", citations: [] },
  });

  // gate.await was sent
  assert.equal(conn.sent.length, 1);
  const sent = conn.sent[0]!;
  assert.equal(sent.kind, "gate.await");
  assert.equal((sent as Extract<WorkerToServer, { kind: "gate.await" }>).runId, "run-1");
  assert.equal((sent as Extract<WorkerToServer, { kind: "gate.await" }>).gateKind, "post_research");

  conn.emitMessage({
    kind: "gate.decided",
    runId: "run-1",
    gateKind: "post_research",
    decision: "approved",
  });

  const decided = await promise;
  assert.equal(decided.decision, "approved");
  assert.equal(decided.feedback, undefined);
  assert.equal(conn.listenerCount("message"), 0, "message listener removed");
});

test("awaitGate: ignores gate.decided for foreign (runId, gateKind)", async () => {
  const conn = fakeConn() as unknown as FakeConnection;
  const promise = awaitGate({
    connection: conn as unknown as YavinConnection,
    runId: "run-1",
    gateKind: "post_research",
    payload: {},
  });

  conn.emitMessage({
    kind: "gate.decided",
    runId: "run-2",
    gateKind: "post_research",
    decision: "approved",
  });
  conn.emitMessage({
    kind: "gate.decided",
    runId: "run-1",
    gateKind: "post_plan",
    decision: "approved",
  });

  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false);

  // Cleanup so we don't leak.
  conn.emitMessage({
    kind: "gate.decided",
    runId: "run-1",
    gateKind: "post_research",
    decision: "approved",
  });
  await promise;
});

test("awaitGate: rejects with GateCancelledError on run.cancel for the same run", async () => {
  const conn = fakeConn() as unknown as FakeConnection;
  const promise = awaitGate({
    connection: conn as unknown as YavinConnection,
    runId: "run-1",
    gateKind: "post_research",
    payload: {},
  });

  conn.emitMessage({ kind: "run.cancel", runId: "run-1" });

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof GateCancelledError);
    assert.equal((err as GateCancelledError).runId, "run-1");
    return true;
  });
  assert.equal(conn.listenerCount("message"), 0);
});

test("awaitGate: ignores run.cancel for a different run", async () => {
  const conn = fakeConn() as unknown as FakeConnection;
  const promise = awaitGate({
    connection: conn as unknown as YavinConnection,
    runId: "run-1",
    gateKind: "post_research",
    payload: {},
  });

  conn.emitMessage({ kind: "run.cancel", runId: "run-2" });
  await new Promise((r) => setTimeout(r, 20));

  conn.emitMessage({
    kind: "gate.decided",
    runId: "run-1",
    gateKind: "post_research",
    decision: "rejected",
    feedback: "no",
  });
  const decided = await promise;
  assert.equal(decided.decision, "rejected");
  assert.equal(decided.feedback, "no");
});

test("awaitGate: rejects with GateAbortedError on abort", async () => {
  const conn = fakeConn() as unknown as FakeConnection;
  const ac = new AbortController();
  const promise = awaitGate({
    connection: conn as unknown as YavinConnection,
    runId: "run-1",
    gateKind: "post_research",
    payload: {},
    abortSignal: ac.signal,
  });

  ac.abort();
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof GateAbortedError);
    return true;
  });
  assert.equal(conn.listenerCount("message"), 0);
});

test("awaitGate: pre-aborted signal rejects synchronously without sending", async () => {
  const conn = fakeConn() as unknown as FakeConnection;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    awaitGate({
      connection: conn as unknown as YavinConnection,
      runId: "run-1",
      gateKind: "post_research",
      payload: {},
      abortSignal: ac.signal,
    }),
    GateAbortedError,
  );
  assert.equal(conn.sent.length, 0, "no gate.await should have been sent");
});
