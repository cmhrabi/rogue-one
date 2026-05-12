import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WSClient } from "ws";
import pino from "pino";
import { YavinConnection } from "../worker/connection.js";
import { startWorker } from "../worker/index.js";
import type { YavinClient } from "../yavin/client.js";
import type { Run, RepoConfig, Ticket, Stage } from "../protocol.js";
import type {
  SessionConfig,
  SessionResult,
} from "../agents/session.js";

function makeStage(runId: string, id: string, kind: Stage["kind"]): Stage {
  return {
    id,
    runId,
    kind,
    status: "running",
    attempt: 1,
    startedAt: null,
    endedAt: null,
    output: null,
    errorText: null,
  };
}

const validResearch = {
  brief: "rate limits are enforced in src/limiter.ts:14",
  citations: [{ url: "https://example.com/docs" }],
};

function fakeRunSession(
  finalAssistantText: string,
): (cfg: SessionConfig, user: string) => Promise<SessionResult> {
  return async (_cfg, _user) => ({
    finalAssistantText,
    totals: { inputTokens: 100, outputTokens: 50, usd: 0.001 },
    modelId: "claude-sonnet-4-5",
  });
}

function hangingRunSession(): (
  cfg: SessionConfig,
  user: string,
) => Promise<SessionResult> {
  return async (cfg, _user) => {
    await new Promise<never>((_resolve, reject) => {
      cfg.abortSignal?.addEventListener(
        "abort",
        () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true },
      );
    });
    // unreachable
    return {
      finalAssistantText: "",
      totals: { inputTokens: 0, outputTokens: 0, usd: 0 },
      modelId: "x",
    };
  };
}

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

function stubClient(
  overrides: Partial<YavinClient> = {},
  opts: { researchStageId?: string } = {},
): YavinClient {
  const researchStageId = opts.researchStageId ?? "st-research-uuid";
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
    getRun: async (id: string) => ({
      run: makeRun(id),
      stages: [makeStage(id, researchStageId, "research")],
      events: [],
    }),
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

test("startWorker: run.start drives real research flow with injected runSession", async () => {
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
      runSessionFn: fakeRunSession(JSON.stringify(validResearch)),
    });
    const serverWs = await h.firstClient;

    const messagesP = collectMessages(serverWs, 4, 3000);
    serverWs.send(
      JSON.stringify({
        kind: "run.start",
        run: makeRun("run-abc"),
        repoConfig: makeRepoConfig(),
        ticket: makeTicket(),
      }),
    );
    const msgs = (await messagesP) as Array<Record<string, unknown>>;

    // Order: stage.started, event.append (log "worker received run …"),
    // stage.completed (output = validResearch), gate.await (post_research).
    assert.equal(msgs[0]!.kind, "stage.started");
    assert.equal((msgs[0] as { runId: string }).runId, "run-abc");

    assert.equal(msgs[1]!.kind, "event.append");
    const ev = (msgs[1] as {
      event: { runId: string; kind: string; payload: { message: string } };
    }).event;
    assert.equal(ev.runId, "run-abc");
    assert.equal(ev.kind, "log");
    assert.match(ev.payload.message, /run-abc/);

    assert.equal(msgs[2]!.kind, "stage.completed");
    const completedStage = (msgs[2] as {
      stage: { status: string; output: unknown };
    }).stage;
    assert.equal(completedStage.status, "completed");
    assert.deepEqual(completedStage.output, validResearch);

    assert.equal(msgs[3]!.kind, "gate.await");
    assert.equal((msgs[3] as { gateKind: string }).gateKind, "post_research");
    assert.deepEqual((msgs[3] as { payload: unknown }).payload, validResearch);

    await w.stop();
  } finally {
    await h.close();
  }
});

test("startWorker: invalid research output emits stage.failed with the real stage UUID", async () => {
  const h = await startServer();
  try {
    const connection = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_t",
      logger: silentLogger,
    });
    const w = await startWorker({
      client: stubClient({}, { researchStageId: "st-research-uuid" }),
      connection,
      logger: silentLogger,
      installSignalHandlers: false,
      runSessionFn: fakeRunSession("not json at all"),
    });
    const serverWs = await h.firstClient;

    // Expect: stage.started, event.append (log), event.append ("research output invalid"),
    // stage.failed.
    const collected: Array<Record<string, unknown>> = [];
    const failedP = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for stage.failed")),
        3000,
      );
      const onMsg = (data: Buffer): void => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed.kind === "pong") return;
        collected.push(parsed);
        if (parsed.kind === "stage.failed") {
          clearTimeout(timer);
          serverWs.off("message", onMsg);
          resolve(parsed);
        }
      };
      serverWs.on("message", onMsg);
    });

    serverWs.send(
      JSON.stringify({
        kind: "run.start",
        run: makeRun("run-bad"),
        repoConfig: makeRepoConfig(),
        ticket: makeTicket(),
      }),
    );

    const failed = await failedP;
    assert.equal(failed.kind, "stage.failed");
    assert.equal((failed as { runId: string }).runId, "run-bad");
    assert.equal(
      (failed as { stageId: string }).stageId,
      "st-research-uuid",
    );
    assert.match(
      (failed as { error: string }).error,
      /StageOutputInvalidError/,
    );

    await w.stop();
  } finally {
    await h.close();
  }
});

test("startWorker: run.cancel aborts the in-flight research stage", async () => {
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
      runSessionFn: hangingRunSession(),
    });
    const serverWs = await h.firstClient;

    const received: Array<Record<string, unknown>> = [];
    serverWs.on("message", (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.kind !== "pong") received.push(parsed);
    });

    serverWs.send(
      JSON.stringify({
        kind: "run.start",
        run: makeRun("run-cxl"),
        repoConfig: makeRepoConfig(),
        ticket: makeTicket(),
      }),
    );

    // Wait for stage.started + the log event to land, then cancel.
    await new Promise((r) => setTimeout(r, 150));
    serverWs.send(JSON.stringify({ kind: "run.cancel", runId: "run-cxl" }));

    // Give the worker a moment to wind down.
    await new Promise((r) => setTimeout(r, 200));

    // No stage.completed should appear.
    const completed = received.find((m) => m.kind === "stage.completed");
    assert.equal(completed, undefined, "stage.completed must not be sent");

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
