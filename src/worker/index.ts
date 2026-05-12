import { spawnSync } from "node:child_process";
import { YavinClient } from "../yavin/client.js";
import { YavinConnection } from "./connection.js";
import { createLogger, type Logger } from "../util/log.js";
import { EventEmitter } from "./eventEmitter.js";
import {
  runResearchStage,
  StageOutputInvalidError,
  type RunSessionFn,
} from "../pipeline/stages/research.js";
import {
  awaitGate,
  GateAbortedError,
  GateCancelledError,
} from "../pipeline/gates.js";
import type {
  RepoConfig,
  Run,
  ServerToWorker,
  Stage,
  StageKind,
  Ticket,
} from "../protocol.js";

export interface StartWorkerOptions {
  client?: YavinClient;
  connection?: YavinConnection;
  logger?: Logger;
  /** Skip installing process signal handlers (tests). */
  installSignalHandlers?: boolean;
  /** Inject a fake Claude session (tests). */
  runSessionFn?: RunSessionFn;
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
  const result: ResolvedEnv = {
    yavinUrl: yavinUrl as string,
    yavinApiKey: yavinApiKey as string,
  };
  const label = process.env.ROGUE_ONE_WORKER_LABEL;
  if (label !== undefined) result.workerLabel = label;
  return result;
}

function checkClaudeCli(logger: Logger): void {
  const claudePath = process.env.CLAUDE_CODE_EXECUTABLE ?? "claude";
  const result = spawnSync(claudePath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    logger.warn(
      { claudePath, code: result.status, err: result.error?.message },
      "claude CLI not found on PATH — research stage will fail when a run arrives. Install Claude Code and run `claude login`.",
    );
    return;
  }
  logger.info({ version: result.stdout.trim() }, "claude CLI: ok");
  if (process.env.ANTHROPIC_API_KEY) {
    logger.warn(
      "ANTHROPIC_API_KEY is set; the SDK will bill via the Anthropic API instead of your Claude Code subscription. Unset it to use subscription auth.",
    );
  }
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

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Look up the UUID of the active stage of `kind` for `runId`. Retries briefly to
 *  tolerate the race where `stage.started` is in flight to the server. */
async function findStageUuid(
  client: YavinClient,
  runId: string,
  kind: StageKind,
  logger: Logger,
): Promise<string | null> {
  const delays = [100, 300, 900];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    try {
      const { stages } = await client.getRun(runId);
      const stage = stages.find((s) => s.kind === kind);
      if (stage?.id) return stage.id;
    } catch (err) {
      logger.warn({ err, runId, attempt }, "findStageUuid: getRun failed");
    }
    await delay(delays[attempt]!);
  }
  return null;
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

  checkClaudeCli(logger);

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

  const eventEmitter = new EventEmitter(connection, client, logger);

  // One AbortController per in-flight run, so run.cancel can interrupt the
  // research stage and any awaiting gate.
  const inFlight = new Map<string, AbortController>();

  const handleMessage = (msg: ServerToWorker): void => {
    switch (msg.kind) {
      case "run.start":
        void handleRunStart(msg.run, msg.ticket, msg.repoConfig);
        return;
      case "gate.decided":
        logger.info(
          { runId: msg.runId, gateKind: msg.gateKind, decision: msg.decision },
          "gate.decided received",
        );
        return;
      case "run.cancel": {
        const controller = inFlight.get(msg.runId);
        if (controller) {
          logger.info({ runId: msg.runId }, "run.cancel: aborting in-flight run");
          controller.abort();
        } else {
          logger.info({ runId: msg.runId }, "run.cancel received (no in-flight run)");
        }
        return;
      }
      case "ping":
        return;
      default: {
        const _exhaustive: never = msg;
        logger.warn({ msg: _exhaustive }, "unknown ServerToWorker kind");
        return;
      }
    }
  };

  const handleRunStart = async (
    run: Run,
    ticket: Ticket,
    repoConfig: RepoConfig,
  ): Promise<void> => {
    const runId = run.id;
    logger.info({ runId }, "run.start: beginning research stage");

    const controller = new AbortController();
    inFlight.set(runId, controller);

    const sink = eventEmitter.bindRun(runId);
    let stage = placeholderStage(runId, "research");
    connection.send({ kind: "stage.started", runId, stage });
    sink.log(`worker received run ${runId}`);

    // Resolve the real stage UUID for agent.message records + stage.failed.
    let stageUuid: string | null = null;
    try {
      stageUuid = await findStageUuid(client, runId, "research", logger);
      if (stageUuid) sink.setCurrentStageUuid(stageUuid);
      else
        logger.warn(
          { runId },
          "research stage UUID not found — agent.message records will be dropped",
        );
    } catch (err) {
      logger.error({ err, runId }, "findStageUuid threw unexpectedly");
    }

    try {
      const output = await runResearchStage({
        run,
        ticket,
        repoConfig,
        onEvent: sink.fromAgentEvent,
        abortSignal: controller.signal,
        ...(opts.runSessionFn !== undefined
          ? { runSessionFn: opts.runSessionFn }
          : {}),
      });

      const completedStage: Stage = {
        ...stage,
        ...(stageUuid ? { id: stageUuid } : {}),
        status: "completed",
        output,
      };
      stage = completedStage;
      connection.send({
        kind: "stage.completed",
        runId,
        stage: completedStage,
      });

      const decided = await awaitGate({
        connection,
        runId,
        gateKind: "post_research",
        payload: output,
        abortSignal: controller.signal,
      });
      logger.info(
        { runId, decision: decided.decision },
        "post_research gate decided",
      );
    } catch (err) {
      if (err instanceof StageOutputInvalidError) {
        sink.log("research output invalid", {
          issues: err.issues,
          raw: err.raw,
        });
        if (stageUuid) {
          connection.send({
            kind: "stage.failed",
            runId,
            stageId: stageUuid,
            error: `StageOutputInvalidError: ${err.message}`,
          });
        } else {
          logger.error(
            { runId },
            "cannot send stage.failed — UUID unknown",
          );
        }
      } else if (
        err instanceof GateCancelledError ||
        err instanceof GateAbortedError ||
        controller.signal.aborted
      ) {
        logger.info({ runId }, "run aborted / gate cancelled — exiting handler");
      } else {
        logger.error({ err, runId }, "run.start: handler failed");
        if (stageUuid) {
          connection.send({
            kind: "stage.failed",
            runId,
            stageId: stageUuid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      inFlight.delete(runId);
    }
  };

  connection.on("message", handleMessage);
  await connection.connect();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const [, ac] of inFlight) ac.abort();
    inFlight.clear();
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
