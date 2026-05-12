import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runResearchStage,
  extractJsonObject,
  StageOutputInvalidError,
  type RunSessionFn,
} from "./research.js";
import type { Run, RepoConfig, Ticket } from "../../protocol.js";
import type { SessionConfig, SessionResult } from "../../agents/session.js";

function makeRun(): Run {
  return {
    id: "run-1",
    repoConfigId: "rc-1",
    ticketProvider: "jira",
    ticketId: "ENG-1",
    ticketUrl: "https://jira.example.com/ENG-1",
    instructions: "investigate rate limits",
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
    title: "Investigate rate limits",
    body: "Where is rate limiting enforced today?",
  };
}

function stubRunSession(finalAssistantText: string): RunSessionFn {
  return async (_cfg: SessionConfig, _user: string): Promise<SessionResult> => ({
    finalAssistantText,
    totals: { inputTokens: 100, outputTokens: 50, usd: 0.001 },
    modelId: "claude-sonnet-4-5",
  });
}

const validOutput = {
  brief: "Rate limits are enforced in src/server/limiter.ts:14",
  citations: [{ url: "https://example.com/docs", title: "docs" }],
};

test("runResearchStage: parses raw JSON output", async () => {
  const out = await runResearchStage({
    run: makeRun(),
    ticket: makeTicket(),
    repoConfig: makeRepoConfig(),
    onEvent: () => {},
    abortSignal: new AbortController().signal,
    runSessionFn: stubRunSession(JSON.stringify(validOutput)),
  });
  assert.equal(out.brief, validOutput.brief);
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0]!.url, "https://example.com/docs");
});

test("runResearchStage: parses JSON inside a ```json fence", async () => {
  const text = "Here's the result:\n```json\n" + JSON.stringify(validOutput) + "\n```\nthanks";
  const out = await runResearchStage({
    run: makeRun(),
    ticket: makeTicket(),
    repoConfig: makeRepoConfig(),
    onEvent: () => {},
    abortSignal: new AbortController().signal,
    runSessionFn: stubRunSession(text),
  });
  assert.equal(out.brief, validOutput.brief);
});

test("runResearchStage: extracts { ... } substring when narration surrounds it", async () => {
  const text = "Sure — " + JSON.stringify(validOutput) + " — done.";
  const out = await runResearchStage({
    run: makeRun(),
    ticket: makeTicket(),
    repoConfig: makeRepoConfig(),
    onEvent: () => {},
    abortSignal: new AbortController().signal,
    runSessionFn: stubRunSession(text),
  });
  assert.equal(out.brief, validOutput.brief);
});

test("runResearchStage: throws StageOutputInvalidError on garbage", async () => {
  await assert.rejects(
    runResearchStage({
      run: makeRun(),
      ticket: makeTicket(),
      repoConfig: makeRepoConfig(),
      onEvent: () => {},
      abortSignal: new AbortController().signal,
      runSessionFn: stubRunSession("not json at all"),
    }),
    (err: unknown) => {
      assert.ok(err instanceof StageOutputInvalidError);
      return true;
    },
  );
});

test("runResearchStage: throws StageOutputInvalidError when zod validation fails", async () => {
  await assert.rejects(
    runResearchStage({
      run: makeRun(),
      ticket: makeTicket(),
      repoConfig: makeRepoConfig(),
      onEvent: () => {},
      abortSignal: new AbortController().signal,
      runSessionFn: stubRunSession(JSON.stringify({ citations: [] })),
    }),
    (err: unknown) => {
      assert.ok(err instanceof StageOutputInvalidError);
      assert.ok(
        (err as StageOutputInvalidError).issues.length > 0,
        "zod issues should be populated",
      );
      return true;
    },
  );
});

test("runResearchStage: propagates onEvent + abortSignal + cwd to runSession", async () => {
  let captured: SessionConfig | null = null;
  const runSessionFn: RunSessionFn = async (cfg, _user) => {
    captured = cfg;
    return {
      finalAssistantText: JSON.stringify(validOutput),
      totals: { inputTokens: 1, outputTokens: 1, usd: 0 },
      modelId: "x",
    };
  };
  const onEvent = (): void => {};
  const ac = new AbortController();
  await runResearchStage({
    run: makeRun(),
    ticket: makeTicket(),
    repoConfig: makeRepoConfig(),
    onEvent,
    abortSignal: ac.signal,
    runSessionFn,
  });
  assert.ok(captured);
  assert.equal(captured!.cwd, "/tmp/demo");
  assert.equal(captured!.onEvent, onEvent);
  assert.equal(captured!.abortSignal, ac.signal);
  assert.deepEqual(captured!.allowedTools, [
    "Read",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
  ]);
});

test("extractJsonObject: handles unfenced object with leading whitespace", () => {
  const obj = extractJsonObject('   {"a":1}\n');
  assert.deepEqual(obj, { a: 1 });
});

test("extractJsonObject: handles unlabelled fence", () => {
  const obj = extractJsonObject('```\n{"a":1}\n```');
  assert.deepEqual(obj, { a: 1 });
});

test("extractJsonObject: throws on completely empty input", () => {
  assert.throws(() => extractJsonObject(""), StageOutputInvalidError);
});
