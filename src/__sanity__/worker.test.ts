import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WSClient } from "ws";
import pino from "pino";
import { YavinConnection } from "../worker/connection.js";
import { startWorker } from "../worker/index.js";
import type { YavinClient } from "../yavin/client.js";
import type { Run, RepoConfig, Ticket } from "../protocol.js";

const silentLogger = pino({ level: "silent" });

interface ServerHarness {
  server: Server;
  wss: WebSocketServer;
  port: number;
  firstClient: Promise<WSClient>;
  close: () => Promise<void>;
}

async function startServer(): Promise<ServerHarness> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let resolveFirst: (ws: WSClient) => void;
  const firstClient = new Promise<WSClient>((r) => (resolveFirst = r));
  let gotFirst = false;

  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      if (!gotFirst) {
        gotFirst = true;
        resolveFirst(ws);
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    wss,
    port,
    firstClient,
    close: () =>
      new Promise<void>((r) => {
        wss.close(() => server.close(() => r()));
      }),
  };
}

function stubClient(overrides: Partial<YavinClient> = {}): YavinClient {
  const base = {
    getHealth: async () => ({ ok: true as const }),
    whoami: async () => ({
      kind: "apiKey" as const,
      userId: "u-test",
      keyId: "k-test",
      label: "test-key",
    }),
    createRun: async () => {
      throw new Error("not used in worker tests");
    },
    getRun: async () => {
      throw new Error("not used in worker tests");
    },
    ...overrides,
  };
  return base as unknown as YavinClient;
}

function makeRun(id: string): Run {
  return {
    id,
    repoConfigId: "rc-1",
    ticketProvider: "jira",
    ticketId: "ENG-1",
    ticketUrl: "https://jira.example.com/ENG-1",
    instructions: "do the thing",
    branchName: null,
    worktreePath: null,
    status: "researching",
    currentStage: "research",
    createdBy: "u-test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeRepoConfig(): RepoConfig {
  return {
    id: "rc-1",
    name: "demo",
    repoPath: "/tmp/demo",
    baseBranch: "main",
    branchPrefix: "rogue/",
    concurrencyLimit: 1,
    ticketProviders: ["jira"],
    githubRepo: "owner/demo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeTicket(): Ticket {
  return {
    provider: "jira",
    id: "ENG-1",
    url: "https://jira.example.com/ENG-1",
    title: "Fix the thing",
    body: "details",
  };
}

async function collectMessages(
  client: WSClient,
  count: number,
  timeoutMs = 1000,
): Promise<unknown[]> {
  const out: unknown[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${count} messages, got ${out.length}`)),
      timeoutMs,
    );
    const onMsg = (data: Buffer): void => {
      const parsed = JSON.parse(data.toString());
      if (parsed.kind === "pong") return;
      out.push(parsed);
      if (out.length >= count) {
        clearTimeout(timer);
        client.off("message", onMsg);
        resolve(out);
      }
    };
    client.on("message", onMsg);
  });
}

test("startWorker: calls whoami and connects", async () => {
  const h = await startServer();
  try {
    let whoamiCalled = false;
    const client = stubClient({
      whoami: async () => {
        whoamiCalled = true;
        return { kind: "apiKey", userId: "u-1", keyId: "k-1", label: "laptop" };
      },
    });
    const connection = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_t",
      logger: silentLogger,
    });
    const w = await startWorker({
      client,
      connection,
      logger: silentLogger,
      installSignalHandlers: false,
    });
    await h.firstClient;
    assert.equal(whoamiCalled, true);
    await w.stop();
  } finally {
    await h.close();
  }
});

test("startWorker: run.start triggers stub research flow in order", async () => {
  const h = await startServer();
  try {
    const connection = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_t",
      logger: silentLogger,
    });
    const w = await startWorker({
      client: stubClient(),
      connection,
      logger: silentLogger,
      installSignalHandlers: false,
    });
    const serverWs = await h.firstClient;

    const messagesP = collectMessages(serverWs, 4);
    serverWs.send(
      JSON.stringify({
        kind: "run.start",
        run: makeRun("run-abc"),
        repoConfig: makeRepoConfig(),
        ticket: makeTicket(),
      }),
    );
    const msgs = (await messagesP) as Array<Record<string, unknown>>;

    assert.equal(msgs.length, 4);
    assert.equal(msgs[0]!.kind, "stage.started");
    assert.equal((msgs[0] as { runId: string }).runId, "run-abc");
    assert.equal(msgs[1]!.kind, "event.append");
    const ev = (msgs[1] as { event: { runId: string; kind: string; payload: { message: string } } }).event;
    assert.equal(ev.runId, "run-abc");
    assert.equal(ev.kind, "log");
    assert.match(ev.payload.message, /run-abc/);
    assert.equal(msgs[2]!.kind, "stage.completed");
    const completedStage = (msgs[2] as { stage: { status: string; output: unknown } }).stage;
    assert.equal(completedStage.status, "completed");
    assert.deepEqual(completedStage.output, {
      brief: "stub research brief",
      citations: [],
    });
    assert.equal(msgs[3]!.kind, "gate.await");
    assert.equal((msgs[3] as { gateKind: string }).gateKind, "post_research");
    assert.deepEqual((msgs[3] as { payload: unknown }).payload, {
      brief: "stub research brief",
      citations: [],
    });

    await w.stop();
  } finally {
    await h.close();
  }
});

test("startWorker: gate.decided is logged but no messages are sent", async () => {
  const h = await startServer();
  try {
    const connection = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_t",
      logger: silentLogger,
    });
    const w = await startWorker({
      client: stubClient(),
      connection,
      logger: silentLogger,
      installSignalHandlers: false,
    });
    const serverWs = await h.firstClient;

    const received: unknown[] = [];
    serverWs.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.kind !== "pong") received.push(parsed);
    });

    serverWs.send(
      JSON.stringify({
        kind: "gate.decided",
        runId: "run-xyz",
        gateKind: "post_research",
        decision: "approved",
      }),
    );

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 0);
    await w.stop();
  } finally {
    await h.close();
  }
});

test("startWorker: stop() closes the connection", async () => {
  const h = await startServer();
  try {
    const connection = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_t",
      logger: silentLogger,
      backoffBaseMs: 60_000,
    });
    const w = await startWorker({
      client: stubClient(),
      connection,
      logger: silentLogger,
      installSignalHandlers: false,
    });
    const serverWs = await h.firstClient;
    const closed = new Promise<void>((r) => serverWs.on("close", () => r()));
    await w.stop();
    await closed;
  } finally {
    await h.close();
  }
});
