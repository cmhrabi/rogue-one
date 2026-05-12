import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSession,
  AgentSessionError,
  PRICE_TABLE,
  type AgentEvent,
  type QueryFn,
} from "./session.js";

function fakeQuery(messages: unknown[]): QueryFn {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m as never;
    },
  });
}

const sonnetInit = {
  type: "system",
  subtype: "init",
  model: "claude-sonnet-4-5",
};

const assistantWithText = {
  type: "assistant",
  message: {
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "first thought" }],
    usage: { input_tokens: 100, output_tokens: 50 },
  },
};

const assistantWithTool = {
  type: "assistant",
  message: {
    model: "claude-sonnet-4-5",
    content: [
      {
        type: "tool_use",
        id: "tu-1",
        name: "Read",
        input: { path: "src/index.ts" },
      },
    ],
    usage: { input_tokens: 110, output_tokens: 55 },
  },
};

const userWithToolResult = {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu-1",
        content: [{ type: "text", text: "file contents" }],
        is_error: false,
      },
    ],
  },
};

const finalAssistantText = {
  type: "assistant",
  message: {
    model: "claude-sonnet-4-5",
    content: [
      { type: "text", text: '{"brief":"done","citations":[]}' },
    ],
    usage: { input_tokens: 130, output_tokens: 80 },
  },
};

const resultMsg = {
  type: "result",
  subtype: "success",
  usage: { input_tokens: 200, output_tokens: 100 },
  total_cost_usd: 0.001,
};

test("runSession: onEvent fires once per normalized event in order", async () => {
  const events: AgentEvent[] = [];
  const res = await runSession(
    {
      systemPrompt: "system",
      cwd: "/tmp",
      allowedTools: ["Read"],
      onEvent: (e) => events.push(e),
      queryFn: fakeQuery([
        sonnetInit,
        assistantWithText,
        assistantWithTool,
        userWithToolResult,
        finalAssistantText,
        resultMsg,
      ]),
    },
    "go research",
  );

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "system",
    "assistant_text",
    "tool_use",
    "tool_result",
    "assistant_text",
    "result",
  ]);

  // finalAssistantText is the LAST text the assistant emitted.
  assert.equal(res.finalAssistantText, '{"brief":"done","citations":[]}');

  // Terminal result drives totals (overrides per-message accumulation).
  assert.equal(res.totals.inputTokens, 200);
  assert.equal(res.totals.outputTokens, 100);

  // Sonnet pricing: 200/1e6 * 3 + 100/1e6 * 15 = 0.0006 + 0.0015 = 0.0021
  const expectedUsd =
    (200 / 1e6) * PRICE_TABLE["claude-sonnet-4-5"]!.in +
    (100 / 1e6) * PRICE_TABLE["claude-sonnet-4-5"]!.out;
  assert.equal(res.totals.usd, expectedUsd);

  assert.equal(res.modelId, "claude-sonnet-4-5");
});

test("runSession: falls back to per-message usage when no terminal result arrives", async () => {
  const events: AgentEvent[] = [];
  const res = await runSession(
    {
      systemPrompt: "",
      cwd: "/tmp",
      allowedTools: [],
      onEvent: (e) => events.push(e),
      queryFn: fakeQuery([sonnetInit, assistantWithText]),
    },
    "x",
  );
  assert.equal(res.totals.inputTokens, 100);
  assert.equal(res.totals.outputTokens, 50);
});

test("runSession: tool_use event carries name, id, input", async () => {
  const events: AgentEvent[] = [];
  await runSession(
    {
      systemPrompt: "",
      cwd: "/tmp",
      allowedTools: ["Read"],
      onEvent: (e) => events.push(e),
      queryFn: fakeQuery([sonnetInit, assistantWithTool, resultMsg]),
    },
    "x",
  );
  const tu = events.find((e) => e.kind === "tool_use");
  assert.ok(tu);
  assert.equal(tu.toolName, "Read");
  assert.equal(tu.toolUseId, "tu-1");
  assert.deepEqual(tu.toolInput, { path: "src/index.ts" });
});

test("runSession: tool_result event carries id, content, isError=false", async () => {
  const events: AgentEvent[] = [];
  await runSession(
    {
      systemPrompt: "",
      cwd: "/tmp",
      allowedTools: [],
      onEvent: (e) => events.push(e),
      queryFn: fakeQuery([sonnetInit, userWithToolResult, resultMsg]),
    },
    "x",
  );
  const tr = events.find((e) => e.kind === "tool_result");
  assert.ok(tr);
  assert.equal(tr.toolUseId, "tu-1");
  assert.equal(tr.isError, false);
});

test("runSession: aborted before start throws AgentSessionError(ABORTED)", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    runSession(
      {
        systemPrompt: "",
        cwd: "/tmp",
        allowedTools: [],
        abortSignal: ac.signal,
        onEvent: () => {},
        queryFn: fakeQuery([sonnetInit, resultMsg]),
      },
      "x",
    ),
    (err: unknown) => {
      assert.ok(err instanceof AgentSessionError);
      assert.equal((err as AgentSessionError).code, "ABORTED");
      return true;
    },
  );
});

test("runSession: abort during iteration throws AgentSessionError(ABORTED)", async () => {
  const ac = new AbortController();
  const hangingQuery: QueryFn = () => ({
    async *[Symbol.asyncIterator]() {
      yield sonnetInit as never;
      // Wait until abort fires, then throw an AbortError to mimic SDK behaviour.
      await new Promise<never>((_resolve, reject) => {
        ac.signal.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
    },
  });

  const promise = runSession(
    {
      systemPrompt: "",
      cwd: "/tmp",
      allowedTools: [],
      abortSignal: ac.signal,
      onEvent: () => {},
      queryFn: hangingQuery,
    },
    "x",
  );

  // Give the iteration a microtask to attach the abort listener inside the query.
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AgentSessionError);
    assert.equal((err as AgentSessionError).code, "ABORTED");
    return true;
  });
});

test("runSession: SDK throw wraps as AgentSessionError(SDK_ERROR)", async () => {
  const throwingQuery: QueryFn = () => ({
    async *[Symbol.asyncIterator]() {
      yield sonnetInit as never;
      throw new Error("boom");
    },
  });

  await assert.rejects(
    runSession(
      {
        systemPrompt: "",
        cwd: "/tmp",
        allowedTools: [],
        onEvent: () => {},
        queryFn: throwingQuery,
      },
      "x",
    ),
    (err: unknown) => {
      assert.ok(err instanceof AgentSessionError);
      assert.equal((err as AgentSessionError).code, "SDK_ERROR");
      assert.equal((err as AgentSessionError).cause instanceof Error, true);
      return true;
    },
  );
});

test("runSession: unknown model falls back to Sonnet pricing", async () => {
  const customModel = {
    type: "system",
    subtype: "init",
    model: "claude-future-x-1",
  };
  const assistantText = {
    type: "assistant",
    message: {
      model: "claude-future-x-1",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  };
  const result = {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  };

  const res = await runSession(
    {
      systemPrompt: "",
      cwd: "/tmp",
      allowedTools: [],
      onEvent: () => {},
      queryFn: fakeQuery([customModel, assistantText, result]),
    },
    "x",
  );
  // Sonnet pricing fallback: 1.0*3 + 1.0*15 = 18
  assert.equal(res.totals.usd, 18);
});
