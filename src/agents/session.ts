import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface AgentEvent {
  kind:
    | "assistant_text"
    | "tool_use"
    | "tool_result"
    | "system"
    | "result"
    | "raw";
  raw: unknown;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  isError?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
}

export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface SessionConfig {
  systemPrompt: string;
  cwd: string;
  allowedTools: string[];
  maxTurns?: number;
  abortSignal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  /** Injected for tests. Defaults to the SDK `query` function. */
  queryFn?: QueryFn;
  model?: string;
}

export interface SessionResult {
  finalAssistantText: string;
  totals: { inputTokens: number; outputTokens: number; usd: number };
  modelId: string;
}

export class AgentSessionError extends Error {
  readonly code: "ABORTED" | "SDK_ERROR";
  readonly cause?: unknown;
  constructor(
    message: string,
    code: "ABORTED" | "SDK_ERROR",
    cause?: unknown,
  ) {
    super(message);
    this.name = "AgentSessionError";
    this.code = code;
    this.cause = cause;
  }
}

/** USD per 1M tokens (input, output). Task 26 will replace this with a real cost source. */
export const PRICE_TABLE: Record<string, { in: number; out: number }> = {
  "claude-opus-4-5": { in: 15, out: 75 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 0.8, out: 4 },
};

const DEFAULT_PRICE = PRICE_TABLE["claude-sonnet-4-5"]!;

function priceFor(model: string): { in: number; out: number } {
  for (const key of Object.keys(PRICE_TABLE)) {
    if (model.startsWith(key)) return PRICE_TABLE[key]!;
  }
  return DEFAULT_PRICE;
}

function computeUsd(
  inputTokens: number,
  outputTokens: number,
  model: string,
): number {
  const price = priceFor(model);
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function asArray(x: unknown): ContentBlock[] {
  return Array.isArray(x) ? (x as ContentBlock[]) : [];
}

/**
 * Map one SDK message into 0..N AgentEvents (assistant messages with several
 * content blocks fan out; tool_use_id is preserved).
 */
function* normalize(msg: SDKMessage): Generator<AgentEvent> {
  // Treat msg as a loose record — the SDK types are wide, and we only need
  // the discriminator + a small surface of each variant.
  const m = msg as unknown as {
    type?: string;
    subtype?: string;
    model?: string;
    message?: {
      content?: unknown;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    usage?: { input_tokens?: number; output_tokens?: number };
    total_cost_usd?: number;
  };

  switch (m.type) {
    case "system": {
      yield { kind: "system", raw: msg, model: m.model };
      return;
    }
    case "assistant": {
      const blocks = asArray(m.message?.content);
      const usage = m.message?.usage;
      const inputTokens = usage?.input_tokens ?? 0;
      const outputTokens = usage?.output_tokens ?? 0;
      const model = m.message?.model;
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          yield {
            kind: "assistant_text",
            raw: block,
            text: block.text,
            usage: { inputTokens, outputTokens },
            ...(model !== undefined ? { model } : {}),
          };
        } else if (block.type === "tool_use") {
          yield {
            kind: "tool_use",
            raw: block,
            ...(block.name !== undefined ? { toolName: block.name } : {}),
            ...(block.id !== undefined ? { toolUseId: block.id } : {}),
            toolInput: block.input,
          };
        }
      }
      return;
    }
    case "user": {
      const blocks = asArray(m.message?.content);
      for (const block of blocks) {
        if (block.type === "tool_result") {
          yield {
            kind: "tool_result",
            raw: block,
            ...(block.tool_use_id !== undefined
              ? { toolUseId: block.tool_use_id }
              : {}),
            toolOutput: block.content,
            isError: block.is_error === true,
          };
        }
      }
      return;
    }
    case "result": {
      yield {
        kind: "result",
        raw: msg,
        usage: {
          inputTokens: m.usage?.input_tokens ?? 0,
          outputTokens: m.usage?.output_tokens ?? 0,
        },
      };
      return;
    }
    default: {
      yield { kind: "raw", raw: msg };
    }
  }
}

export async function runSession(
  cfg: SessionConfig,
  userMessage: string,
): Promise<SessionResult> {
  if (cfg.abortSignal?.aborted) {
    throw new AgentSessionError("aborted", "ABORTED", cfg.abortSignal.reason);
  }

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(cfg.abortSignal?.reason);
  if (cfg.abortSignal) {
    cfg.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const options: Options = {
    systemPrompt: cfg.systemPrompt,
    cwd: cfg.cwd,
    allowedTools: cfg.allowedTools,
    maxTurns: cfg.maxTurns ?? 50,
    abortController: controller,
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
  };

  const queryFn = cfg.queryFn ?? (defaultQuery as unknown as QueryFn);

  let finalAssistantText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let modelId = cfg.model ?? "claude-sonnet-4-5";
  let sawResult = false;

  try {
    const iter = queryFn({ prompt: userMessage, options });
    for await (const msg of iter) {
      for (const ev of normalize(msg)) {
        if (ev.kind === "system" && ev.model) modelId = ev.model;
        if (ev.kind === "assistant_text") {
          if (ev.text) finalAssistantText = ev.text;
          if (ev.model) modelId = ev.model;
          if (!sawResult && ev.usage) {
            // Per-message accumulation; overridden by the terminal result below.
            inputTokens = Math.max(inputTokens, ev.usage.inputTokens);
            outputTokens = Math.max(outputTokens, ev.usage.outputTokens);
          }
        }
        if (ev.kind === "result" && ev.usage) {
          inputTokens = ev.usage.inputTokens;
          outputTokens = ev.usage.outputTokens;
          sawResult = true;
        }
        cfg.onEvent(ev);
      }
    }
  } catch (err) {
    if (controller.signal.aborted || cfg.abortSignal?.aborted) {
      throw new AgentSessionError("aborted", "ABORTED", err);
    }
    throw new AgentSessionError("agent SDK failed", "SDK_ERROR", err);
  } finally {
    if (cfg.abortSignal) {
      cfg.abortSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  if (cfg.abortSignal?.aborted) {
    throw new AgentSessionError("aborted", "ABORTED", cfg.abortSignal.reason);
  }

  return {
    finalAssistantText,
    totals: {
      inputTokens,
      outputTokens,
      usd: computeUsd(inputTokens, outputTokens, modelId),
    },
    modelId,
  };
}
