import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter as NodeEventEmitter } from "node:events";
import pino from "pino";
import { EventEmitter } from "./eventEmitter.js";
import type { YavinConnection } from "./connection.js";
import type { YavinClient } from "../yavin/client.js";
import type { WorkerToServer } from "../protocol.js";
import type { AgentEvent } from "../agents/session.js";

const silent = pino({ level: "silent" });

class FakeConn extends NodeEventEmitter {
  readonly sent: WorkerToServer[] = [];
  send(msg: WorkerToServer): void {
    this.sent.push(msg);
  }
}

function makeConn(): YavinConnection {
  return new FakeConn() as unknown as YavinConnection;
}

function fakeRest(): YavinClient {
  return {} as YavinClient;
}

function findSent(
  conn: FakeConn,
  kind: WorkerToServer["kind"],
): WorkerToServer[] {
  return conn.sent.filter((m) => m.kind === kind);
}

test("log/toolCall/toolResult send immediately with stageId=null when no UUID", () => {
  const conn = makeConn() as unknown as FakeConn;
  const ee = new EventEmitter(
    conn as unknown as YavinConnection,
    fakeRest(),
    silent,
  );
  const sink = ee.bindRun("run-1");

  sink.log("hello");
  sink.toolCall("Read", { path: "src/index.ts" });
  sink.toolResult("Read", true, "contents");

  const events = findSent(conn, "event.append") as Extract<
    WorkerToServer,
    { kind: "event.append" }
  >[];
  assert.equal(events.length, 3);
  for (const ev of events) {
    assert.equal(ev.event.runId, "run-1");
    assert.equal(ev.event.stageId, null);
  }
  assert.equal(events[0]!.event.kind, "log");
  assert.equal(events[1]!.event.kind, "tool_call");
  assert.equal(events[2]!.event.kind, "tool_result");
});

test("agentMessage buffered until UUID, then flushed in order", () => {
  const conn = makeConn() as unknown as FakeConn;
  const ee = new EventEmitter(
    conn as unknown as YavinConnection,
    fakeRest(),
    silent,
  );
  const sink = ee.bindRun("run-1");

  sink.agentMessage({ role: "assistant", content: "first" });
  sink.agentMessage({ role: "assistant", content: "second" });
  sink.agentMessage({ role: "assistant", content: "third" });

  assert.equal(findSent(conn, "agent.message").length, 0);

  sink.setCurrentStageUuid("st-1");

  const msgs = findSent(conn, "agent.message") as Extract<
    WorkerToServer,
    { kind: "agent.message" }
  >[];
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0]!.message.content, "first");
  assert.equal(msgs[1]!.message.content, "second");
  assert.equal(msgs[2]!.message.content, "third");
  for (const m of msgs) {
    assert.equal(m.message.runId, "run-1");
    assert.equal(m.message.stageId, "st-1");
  }
});

test("agentMessage queue cap drops oldest with a critical log", () => {
  const conn = makeConn() as unknown as FakeConn;
  const ee = new EventEmitter(
    conn as unknown as YavinConnection,
    fakeRest(),
    silent,
    { agentMessageQueueMax: 2 },
  );
  const sink = ee.bindRun("run-1");

  sink.agentMessage({ role: "assistant", content: "a" });
  sink.agentMessage({ role: "assistant", content: "b" });
  sink.agentMessage({ role: "assistant", content: "c" });
  sink.agentMessage({ role: "assistant", content: "d" });

  sink.setCurrentStageUuid("st-1");

  const msgs = findSent(conn, "agent.message") as Extract<
    WorkerToServer,
    { kind: "agent.message" }
  >[];
  assert.equal(msgs.length, 2, "only newest 2 should survive");
  assert.equal(msgs[0]!.message.content, "c");
  assert.equal(msgs[1]!.message.content, "d");
});

test("agentMessage sends immediately once UUID is set", () => {
  const conn = makeConn() as unknown as FakeConn;
  const ee = new EventEmitter(
    conn as unknown as YavinConnection,
    fakeRest(),
    silent,
  );
  const sink = ee.bindRun("run-1");
  sink.setCurrentStageUuid("st-1");

  sink.agentMessage({
    role: "assistant",
    content: "hi",
    usage: { inputTokens: 10, outputTokens: 5 },
    modelId: "claude-sonnet-4-5",
    usdCost: 0.001,
  });

  const msgs = findSent(conn, "agent.message") as Extract<
    WorkerToServer,
    { kind: "agent.message" }
  >[];
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.message.tokensIn, 10);
  assert.equal(msgs[0]!.message.tokensOut, 5);
  assert.equal(msgs[0]!.message.model, "claude-sonnet-4-5");
  assert.equal(msgs[0]!.message.costUsd, 0.001);
});

test("setCurrentStageUuid(null) stops further sends; later UUID resumes", () => {
  const conn = makeConn() as unknown as FakeConn;
  const ee = new EventEmitter(
    conn as unknown as YavinConnection,
    fakeRest(),
    silent,
  );
  const sink = ee.bindRun("run-1");
  sink.setCurrentStageUuid("st-1");
  sink.agentMessage({ role: "assistant", content: "a" });
  sink.setCurrentStageUuid(null);
  sink.agentMessage({ role: "assistant", content: "b" });
  // Still buffered while uuid is null.
  assert.equal(findSent(conn, "agent.message").length, 1);

  sink.setCurrentStageUuid("st-2");
  const msgs = findSent(conn, "agent.message") as Extract<
    WorkerToServer,
    { kind: "agent.message" }
  >[];
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1]!.message.stageId, "st-2");
});

test("fromAgentEvent routes assistant_text → agentMessage with usage and model", () => {
  const conn = makeConn() as unknown as FakeConn;
  const ee = new EventEmitter(
    conn as unknown as YavinConnection,
    fakeRest(),
    silent,
  );
  const sink = ee.bindRun("run-1");
  sink.setCurrentStageUuid("st-1");

  const ev: AgentEvent = {
    kind: "assistant_text",
    raw: {},
    text: "thinking",
    usage: { inputTokens: 30, outputTokens: 12 },
    model: "claude-sonnet-4-5",
  };
  sink.fromAgentEvent(ev);

  const msgs = findSent(conn, "agent.message") as Extract<
    WorkerToServer,
    { kind: "agent.message" }
  >[];
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.message.role, "assistant");
  assert.equal(msgs[0]!.message.content, "thinking");
  assert.equal(msgs[0]!.message.tokensIn, 30);
  assert.equal(msgs[0]!.message.model, "claude-sonnet-4-5");
});

test("fromAgentEvent routes tool_use → toolCall and tool_result → toolResult", () => {
  const conn = makeConn() as unknown as FakeConn;
  const ee = new EventEmitter(
    conn as unknown as YavinConnection,
    fakeRest(),
    silent,
  );
  const sink = ee.bindRun("run-1");
  sink.setCurrentStageUuid("st-1");

  sink.fromAgentEvent({
    kind: "tool_use",
    raw: {},
    toolName: "Grep",
    toolInput: { pattern: "x" },
  });
  sink.fromAgentEvent({
    kind: "tool_result",
    raw: {},
    toolName: "Grep",
    toolOutput: "match",
    isError: false,
  });

  const events = findSent(conn, "event.append") as Extract<
    WorkerToServer,
    { kind: "event.append" }
  >[];
  assert.equal(events.length, 2);
  assert.equal(events[0]!.event.kind, "tool_call");
  assert.equal(events[1]!.event.kind, "tool_result");
  const trPayload = events[1]!.event.payload as {
    name: string;
    ok: boolean;
    result: unknown;
  };
  assert.equal(trPayload.name, "Grep");
  assert.equal(trPayload.ok, true);
});

test("fromAgentEvent routes system and result → log", () => {
  const conn = makeConn() as unknown as FakeConn;
  const ee = new EventEmitter(
    conn as unknown as YavinConnection,
    fakeRest(),
    silent,
  );
  const sink = ee.bindRun("run-1");
  sink.setCurrentStageUuid("st-1");

  sink.fromAgentEvent({ kind: "system", raw: {}, model: "claude-sonnet-4-5" });
  sink.fromAgentEvent({
    kind: "result",
    raw: {},
    usage: { inputTokens: 100, outputTokens: 50 },
    model: "claude-sonnet-4-5",
  });

  const events = findSent(conn, "event.append") as Extract<
    WorkerToServer,
    { kind: "event.append" }
  >[];
  assert.equal(events.length, 2);
  for (const ev of events) {
    assert.equal(ev.event.kind, "log");
    assert.equal(ev.event.stageId, "st-1");
  }
});
