import { z, type ZodIssue } from "zod";
import { ResearchOutput } from "../../protocol.js";
import type { RepoConfig, Run, Ticket } from "../../protocol.js";
import {
  runSession as defaultRunSession,
  type AgentEvent,
  type SessionConfig,
  type SessionResult,
} from "../../agents/session.js";
import { loadPrompt } from "../../agents/prompts/index.js";

export type ResearchOutputT = z.infer<typeof ResearchOutput>;

export class StageOutputInvalidError extends Error {
  readonly issues: ZodIssue[];
  readonly raw: string;
  constructor(issues: ZodIssue[], raw: string) {
    super(`stage output invalid: ${issues.map((i) => i.message).join("; ") || "no JSON found"}`);
    this.name = "StageOutputInvalidError";
    this.issues = issues;
    this.raw = raw;
  }
}

export type RunSessionFn = (
  cfg: SessionConfig,
  userMessage: string,
) => Promise<SessionResult>;

export interface RunResearchStageInput {
  run: Run;
  ticket: Ticket;
  repoConfig: RepoConfig;
  onEvent: (e: AgentEvent) => void;
  abortSignal: AbortSignal;
  /** Injected for tests. */
  runSessionFn?: RunSessionFn;
}

const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"] as const;

function buildUserMessage(run: Run, ticket: Ticket): string {
  const lines: string[] = [
    `Ticket: ${ticket.provider}#${ticket.id}`,
    `Title: ${ticket.title}`,
    `URL: ${ticket.url}`,
    `Instructions: ${run.instructions}`,
    "",
    "Description:",
    ticket.body,
  ];
  if (ticket.related && ticket.related.length > 0) {
    lines.push("", "Related items:");
    for (const r of ticket.related) {
      lines.push(`- [${r.relation}] ${r.id} — ${r.title} (${r.url})`);
    }
  }
  return lines.join("\n");
}

/**
 * Extract a JSON object from an assistant's final text. Tolerates:
 *   - raw JSON
 *   - JSON inside a ```json ...``` fence (or unlabelled fence)
 *   - trailing/leading narration around `{ ... }`
 * Throws `StageOutputInvalidError` if nothing parseable is found.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to broader search
    }
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }

  throw new StageOutputInvalidError(
    [
      {
        code: "custom",
        path: [],
        message: "no JSON object found in assistant output",
      } as ZodIssue,
    ],
    text,
  );
}

export async function runResearchStage(
  input: RunResearchStageInput,
): Promise<ResearchOutputT> {
  const runSession = input.runSessionFn ?? defaultRunSession;
  const systemPrompt = loadPrompt("researcher");
  const userMessage = buildUserMessage(input.run, input.ticket);

  const result = await runSession(
    {
      systemPrompt,
      cwd: input.repoConfig.repoPath,
      allowedTools: Array.from(ALLOWED_TOOLS),
      onEvent: input.onEvent,
      abortSignal: input.abortSignal,
    },
    userMessage,
  );

  const obj = extractJsonObject(result.finalAssistantText);
  const parsed = ResearchOutput.safeParse(obj);
  if (!parsed.success) {
    throw new StageOutputInvalidError(parsed.error.issues, result.finalAssistantText);
  }
  return parsed.data;
}
