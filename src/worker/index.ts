import { YavinClient } from "../yavin/client.js";
import { YavinConnection } from "./connection.js";
import { createLogger, type Logger } from "../util/log.js";
import type {
  ServerToWorker,
  Stage,
  StageKind,
  GateKind,
} from "../protocol.js";

export interface StartWorkerOptions {
  client?: YavinClient;
  connection?: YavinConnection;
  logger?: Logger;
  /** Skip installing process signal handlers (tests). */
  installSignalHandlers?: boolean;
}

export interface StartedWorker {
  stop: () => Promise<void>;
}

interface ResolvedEnv {
  yavinUrl: string;
  yavinApiKey: string;
  workerLabel?: string;
}

function readEnv(): ResolvedEnv {
  const yavinUrl = process.env.YAVIN_URL ?? process.env.YAVIN_BASE_URL;
  const yavinApiKey = process.env.YAVIN_API_KEY;
  const missing: string[] = [];
  if (!yavinUrl) missing.push("YAVIN_URL (or YAVIN_BASE_URL)");
  if (!yavinApiKey) missing.push("YAVIN_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `rogue-one worker: missing required env: ${missing.join(", ")}`,
    );
  }
  return {
    yavinUrl: yavinUrl as string,
    yavinApiKey: yavinApiKey as string,
    workerLabel: process.env.ROGUE_ONE_WORKER_LABEL,
  };
}

function stubResearchOutput(): { brief: string; citations: [] } {
  return { brief: "stub research brief", citations: [] };
}

function placeholderStage(runId: string, kind: StageKind): Stage {
  return {
    id: "",
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

export async function startWorker(
  opts: StartWorkerOptions = {},
): Promise<StartedWorker> {
  const logger = opts.logger ?? createLogger("worker");
  const needsEnv = !opts.client || !opts.connection;
  const env = needsEnv ? readEnv() : null;
  if (env?.workerLabel) {
    logger.info({ workerLabel: env.workerLabel }, "rogue-one worker: starting");
  } else {
    logger.info("rogue-one worker: starting");
  }

  const client =
    opts.client ??
    new YavinClient({ baseUrl: env!.yavinUrl, apiKey: env!.yavinApiKey });

  await client.getHealth();
  const me = await client.whoami();
  logger.info({ apiKeyLabel: me.label, userId: me.userId }, "yavin: whoami ok");

  const connection =
    opts.connection ??
    new YavinConnection({
      url: env!.yavinUrl,
      apiKey: env!.yavinApiKey,
      logger,
    });

  const handleMessage = (msg: ServerToWorker): void => {
    switch (msg.kind) {
      case "run.start":
        handleRunStart(msg.run.id);
        return;
      case "gate.decided":
        logger.info(
          { runId: msg.runId, gateKind: msg.gateKind, decision: msg.decision },
          "gate.decided received (no-op this phase)",
        );
        return;
      case "run.cancel":
        logger.info(
          { runId: msg.runId },
          "run.cancel received (no-op this phase)",
        );
        return;
      case "ping":
        return;
      default: {
        const _exhaustive: never = msg;
        logger.warn({ msg: _exhaustive }, "unknown ServerToWorker kind");
        return;
      }
    }
  };

  const handleRunStart = (runId: string): void => {
    logger.info({ runId }, "run.start: emitting stub research flow");
    const stage = placeholderStage(runId, "research");
    connection.send({ kind: "stage.started", runId, stage });
    connection.send({
      kind: "event.append",
      event: {
        runId,
        stageId: null,
        kind: "log",
        payload: { message: `stub worker received run ${runId}` },
      },
    });
    const output = stubResearchOutput();
    const completedStage: Stage = {
      ...stage,
      status: "completed",
      output,
    };
    connection.send({
      kind: "stage.completed",
      runId,
      stage: completedStage,
    });
    const gateKind: GateKind = "post_research";
    connection.send({ kind: "gate.await", runId, gateKind, payload: output });
  };

  connection.on("message", handleMessage);
  await connection.connect();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    connection.off("message", handleMessage);
    connection.close();
  };

  if (opts.installSignalHandlers !== false) {
    const onSignal = (signal: NodeJS.Signals): void => {
      logger.info({ signal }, "received signal, shutting down");
      void stop().then(() => process.exit(0));
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }

  return { stop };
}
