import type { YavinConnection } from "../worker/connection.js";
import type {
  GateDecision,
  GateKind,
  ServerToWorker,
} from "../protocol.js";

export interface GateDecided {
  decision: GateDecision;
  feedback?: string;
}

export class GateCancelledError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`gate cancelled: run ${runId}`);
    this.name = "GateCancelledError";
    this.runId = runId;
  }
}

export class GateAbortedError extends Error {
  constructor() {
    super("gate aborted");
    this.name = "GateAbortedError";
  }
}

export interface AwaitGateArgs {
  connection: YavinConnection;
  runId: string;
  gateKind: GateKind;
  payload: unknown;
  abortSignal?: AbortSignal;
}

/**
 * Send `gate.await` and resolve when yavin-iv sends a matching `gate.decided`.
 * Rejects with GateCancelledError on `run.cancel` for the same runId.
 * Rejects with GateAbortedError on abort.
 */
export function awaitGate(args: AwaitGateArgs): Promise<GateDecided> {
  const { connection, runId, gateKind, payload, abortSignal } = args;

  return new Promise<GateDecided>((resolve, reject) => {
    let settled = false;

    const handler = (msg: ServerToWorker): void => {
      if (settled) return;
      if (
        msg.kind === "gate.decided" &&
        msg.runId === runId &&
        msg.gateKind === gateKind
      ) {
        const decided: GateDecided = msg.feedback !== undefined
          ? { decision: msg.decision, feedback: msg.feedback }
          : { decision: msg.decision };
        settle();
        resolve(decided);
        return;
      }
      if (msg.kind === "run.cancel" && msg.runId === runId) {
        settle();
        reject(new GateCancelledError(runId));
        return;
      }
    };

    const onAbort = (): void => {
      if (settled) return;
      settle();
      reject(new GateAbortedError());
    };

    const settle = (): void => {
      settled = true;
      connection.off("message", handler);
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    };

    if (abortSignal?.aborted) {
      reject(new GateAbortedError());
      return;
    }

    connection.on("message", handler);
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    connection.send({ kind: "gate.await", runId, gateKind, payload });
  });
}
