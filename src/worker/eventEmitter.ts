import type { YavinConnection } from "./connection.js";
import type { YavinClient } from "../yavin/client.js";
import type { Logger } from "../util/log.js";
import type {
  AgentMessageInput,
  AgentRole,
  EventInput,
} from "../protocol.js";
import type { AgentEvent } from "../agents/session.js";

export interface AgentMessageRecord {
  role: AgentRole;
  content: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  usdCost?: number;
  modelId?: string;
}

export interface RunEventSink {
  setCurrentStageUuid(uuid: string | null): void;
  log(message: string, extra?: unknown): void;
  toolCall(name: string, args: unknown): void;
  toolResult(name: string, ok: boolean, result: unknown): void;
  agentMessage(msg: AgentMessageRecord): void;
  fromAgentEvent(e: AgentEvent): void;
}

export interface EventEmitterOptions {
  /** Bound for agent.message records buffered before a stage UUID arrives. */
  agentMessageQueueMax?: number;
}

const DEFAULT_QUEUE_MAX = 256;

export class EventEmitter {
  private readonly connection: YavinConnection;
  // restClient is reserved for the worker to call client.getRun() on its own;
  // the emitter does not need to call it directly. Kept on the constructor so
  // that future stage-discovery logic can move here without an API break.
  private readonly _restClient: YavinClient;
  private readonly logger: Logger;
  private readonly queueMax: number;

  constructor(
    connection: YavinConnection,
    restClient: YavinClient,
    logger: Logger,
    opts: EventEmitterOptions = {},
  ) {
    this.connection = connection;
    this._restClient = restClient;
    this.logger = logger;
    this.queueMax = opts.agentMessageQueueMax ?? DEFAULT_QUEUE_MAX;
    // Silence unused-private warning while keeping the dep injected.
    void this._restClient;
  }

  bindRun(runId: string): RunEventSink {
    const conn = this.connection;
    const log = this.logger;
    const queueMax = this.queueMax;

    let currentStageUuid: string | null = null;
    const pending: AgentMessageInput[] = [];

    const sendEvent = (kind: string, payload: unknown): void => {
      const event: EventInput = {
        runId,
        stageId: currentStageUuid,
        kind,
        payload,
      };
      conn.send({ kind: "event.append", event });
    };

    const flushPending = (): void => {
      if (!currentStageUuid) return;
      while (pending.length > 0) {
        const next = pending.shift()!;
        const withUuid: AgentMessageInput = { ...next, stageId: currentStageUuid };
        conn.send({ kind: "agent.message", message: withUuid });
      }
    };

    const sink: RunEventSink = {
      setCurrentStageUuid(uuid: string | null): void {
        currentStageUuid = uuid;
        if (uuid) flushPending();
      },

      log(message: string, extra?: unknown): void {
        sendEvent("log", extra !== undefined ? { message, extra } : { message });
      },

      toolCall(name: string, args: unknown): void {
        sendEvent("tool_call", { name, args });
      },

      toolResult(name: string, ok: boolean, result: unknown): void {
        sendEvent("tool_result", { name, ok, result });
      },

      agentMessage(msg: AgentMessageRecord): void {
        const base: AgentMessageInput = {
          runId,
          stageId: currentStageUuid ?? "",
          role: msg.role,
          content: msg.content,
          ...(msg.usage?.inputTokens !== undefined
            ? { tokensIn: msg.usage.inputTokens }
            : {}),
          ...(msg.usage?.outputTokens !== undefined
            ? { tokensOut: msg.usage.outputTokens }
            : {}),
          ...(msg.modelId !== undefined ? { model: msg.modelId } : {}),
          ...(msg.usdCost !== undefined ? { costUsd: msg.usdCost } : {}),
        };

        if (currentStageUuid) {
          conn.send({ kind: "agent.message", message: base });
          return;
        }

        if (pending.length >= queueMax) {
          const dropped = pending.shift();
          log.error(
            { runId, dropped, queueMax },
            "agent.message queue overflow — dropping oldest",
          );
        }
        pending.push(base);
      },

      fromAgentEvent(e: AgentEvent): void {
        switch (e.kind) {
          case "assistant_text": {
            const record: AgentMessageRecord = {
              role: "assistant",
              content: e.text ?? "",
              ...(e.usage !== undefined ? { usage: e.usage } : {}),
              ...(e.model !== undefined ? { modelId: e.model } : {}),
            };
            sink.agentMessage(record);
            return;
          }
          case "tool_use": {
            sink.toolCall(e.toolName ?? "(unknown)", e.toolInput);
            return;
          }
          case "tool_result": {
            sink.toolResult(e.toolName ?? "(unknown)", !e.isError, e.toolOutput);
            return;
          }
          case "system": {
            sink.log("agent session init", { model: e.model });
            return;
          }
          case "result": {
            sink.log("agent session result", { usage: e.usage, model: e.model });
            return;
          }
          case "raw":
          default: {
            sink.log("agent event", e.raw);
            return;
          }
        }
      },
    };

    return sink;
  }
}
