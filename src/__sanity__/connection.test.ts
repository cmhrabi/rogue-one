import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WSClient } from "ws";
import pino from "pino";
import { YavinConnection } from "../worker/connection.js";

const silentLogger = pino({ level: "silent" });

interface ServerHarness {
  server: Server;
  wss: WebSocketServer;
  port: number;
  upgradeUrls: string[];
  /** Resolved with the first ws client to connect. */
  firstClient: Promise<WSClient>;
  close: () => Promise<void>;
}

async function startServer(): Promise<ServerHarness> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const upgradeUrls: string[] = [];
  let resolveFirst: (ws: WSClient) => void;
  const firstClient = new Promise<WSClient>((r) => (resolveFirst = r));
  let gotFirst = false;

  server.on("upgrade", (req, socket, head) => {
    upgradeUrls.push(req.url ?? "");
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
    upgradeUrls,
    firstClient,
    close: () =>
      new Promise<void>((r) => {
        wss.close(() => server.close(() => r()));
      }),
  };
}

test("connect: WS URL carries role=worker and the urlencoded token", async () => {
  const h = await startServer();
  try {
    const conn = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_special chars/+=",
      logger: silentLogger,
    });
    await conn.connect();
    assert.ok(h.upgradeUrls.length >= 1);
    const u = h.upgradeUrls[0]!;
    assert.match(u, /^\/ws\?role=worker&token=/);
    const params = new URL("http://x" + u).searchParams;
    assert.equal(params.get("role"), "worker");
    assert.equal(params.get("token"), "yvn_special chars/+=");
    conn.close();
  } finally {
    await h.close();
  }
});

test("ping → pong round-trip", async () => {
  const h = await startServer();
  try {
    const conn = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_x",
      logger: silentLogger,
    });
    const connectP = conn.connect();
    const client = await h.firstClient;
    await connectP;

    const pongP = new Promise<unknown>((resolve) => {
      client.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    client.send(JSON.stringify({ kind: "ping" }));
    const pong = (await pongP) as { kind: string };
    assert.equal(pong.kind, "pong");
    conn.close();
  } finally {
    await h.close();
  }
});

test("outbox: messages enqueued before open are flushed in FIFO order on open", async () => {
  const h = await startServer();
  try {
    const conn = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_x",
      logger: silentLogger,
    });

    // Enqueue before connect — these must buffer.
    conn.send({ kind: "run.claim", runId: "r-1" });
    conn.send({ kind: "run.claim", runId: "r-2" });
    conn.send({ kind: "run.claim", runId: "r-3" });
    assert.equal(conn.pendingCount, 3);

    const received: unknown[] = [];
    h.wss.on("connection", (ws) => {
      ws.on("message", (data) => received.push(JSON.parse(data.toString())));
    });

    await conn.connect();

    // Wait for the three messages to land.
    for (let i = 0; i < 50 && received.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(received.length, 3, "expected three messages on the server");
    assert.deepEqual(received.map((m) => (m as { runId: string }).runId), ["r-1", "r-2", "r-3"]);
    assert.equal(conn.pendingCount, 0);
    conn.close();
  } finally {
    await h.close();
  }
});

test("reconnect: client retries with backoff after server-side close", async () => {
  const h = await startServer();
  try {
    const conn = new YavinConnection({
      url: `http://127.0.0.1:${h.port}`,
      apiKey: "yvn_x",
      logger: silentLogger,
      backoffBaseMs: 20,
      backoffMaxMs: 200,
    });

    await conn.connect();
    assert.equal(h.upgradeUrls.length, 1);

    // Force-close the first server-side socket.
    const first = await h.firstClient;
    const reconnected = new Promise<void>((resolve) => {
      h.wss.once("connection", () => resolve());
    });
    first.terminate();

    await reconnected;
    assert.ok(h.upgradeUrls.length >= 2, "client should have reconnected");
    conn.close();
  } finally {
    await h.close();
  }
});

test("outbox overflow emits criticalError and refuses further sends", async () => {
  // Don't start a server — socket stays CONNECTING / never OPEN.
  const conn = new YavinConnection({
    url: "ws://127.0.0.1:1",
    apiKey: "yvn_x",
    logger: silentLogger,
    outboxMax: 3,
    backoffBaseMs: 60_000, // prevent stray reconnects from interfering
  });

  let criticalErr: Error | null = null;
  conn.on("criticalError", (err) => {
    criticalErr = err;
  });

  // First 3 buffer fine.
  conn.send({ kind: "run.claim", runId: "r-1" });
  conn.send({ kind: "run.claim", runId: "r-2" });
  conn.send({ kind: "run.claim", runId: "r-3" });

  // 4th tips it over.
  assert.throws(() => conn.send({ kind: "run.claim", runId: "r-4" }));
  assert.ok(criticalErr instanceof Error);

  // Subsequent sends rejected.
  assert.throws(() => conn.send({ kind: "run.claim", runId: "r-5" }));
  conn.close();
});
