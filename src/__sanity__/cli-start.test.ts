import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTicketId, main } from "../cli/index.js";
import { YavinClient, type FetchLike } from "../yavin/client.js";

interface CapturedConsole {
  logs: string[];
  errs: string[];
  restore: () => void;
}

function captureConsole(): CapturedConsole {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return {
    logs,
    errs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

let originalExit: typeof process.exit | null = null;
function stubExit(): { codes: number[]; restore: () => void } {
  const codes: number[] = [];
  originalExit = process.exit;
  process.exit = ((code?: number) => {
    codes.push(code ?? 0);
    throw new Error(`__exit_${code ?? 0}__`);
  }) as typeof process.exit;
  return {
    codes,
    restore: () => {
      if (originalExit) process.exit = originalExit;
    },
  };
}

test("deriveTicketId extracts the last URL path segment", () => {
  assert.equal(
    deriveTicketId("https://jira.example.com/browse/ENG-1"),
    "ENG-1",
  );
  assert.equal(
    deriveTicketId("https://github.com/owner/repo/issues/42"),
    "42",
  );
  assert.equal(
    deriveTicketId("https://linear.app/team/issue/ABC-7/fix-it"),
    "fix-it",
  );
});

test("deriveTicketId falls back to the URL when there is no path", () => {
  assert.equal(deriveTicketId("https://example.com"), "https://example.com");
  assert.equal(deriveTicketId("https://example.com/"), "https://example.com/");
});

test("start: POSTs createRun with derived ticketId and prints dashboard URL", async () => {
  const captured = captureConsole();
  try {
    let postedBody: Record<string, unknown> | null = null;
    const stubFetch: FetchLike = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/runs")) {
        postedBody = JSON.parse((init?.body as string) ?? "{}");
        return new Response(
          JSON.stringify({
            run: {
              id: "run-123",
              repoConfigId: "rc-1",
              ticketProvider: "jira",
              ticketId: "ENG-1",
              ticketUrl: "https://jira.example.com/browse/ENG-1",
              instructions: "fix the thing",
              branchName: null,
              worktreePath: null,
              status: "pending",
              currentStage: null,
              createdBy: "u",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            stages: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected URL ${u}`);
    };
    process.env.YAVIN_URL = "http://yavin.test";
    process.env.YAVIN_API_KEY = "yvn_x";
    await main(
      [
        "start",
        "fix the thing",
        "https://jira.example.com/browse/ENG-1",
        "--repo-config-id",
        "rc-1",
      ],
      {
        createClient: () =>
          new YavinClient({
            baseUrl: "http://yavin.test",
            apiKey: "yvn_x",
            fetch: stubFetch,
          }),
      },
    );
    assert.ok(postedBody, "expected createRun POST");
    const body = postedBody as Record<string, unknown>;
    assert.equal(body.ticketProvider, "jira");
    assert.equal(body.ticketId, "ENG-1");
    assert.equal(body.ticketUrl, "https://jira.example.com/browse/ENG-1");
    assert.equal(body.repoConfigId, "rc-1");
    assert.equal(body.instructions, "fix the thing");
    assert.ok(
      captured.logs.some((l) => l.includes("http://yavin.test/runs/run-123")),
      `expected dashboard URL in logs, got: ${captured.logs.join(" | ")}`,
    );
    assert.ok(
      captured.logs.some((l) => l.includes("Status: pending")),
      "expected status line in logs",
    );
  } finally {
    captured.restore();
  }
});

test("start: missing --repo-config-id exits non-zero", async () => {
  const captured = captureConsole();
  const exit = stubExit();
  try {
    process.env.YAVIN_URL = "http://yavin.test";
    process.env.YAVIN_API_KEY = "yvn_x";
    await assert.rejects(
      () =>
        main(
          [
            "start",
            "fix the thing",
            "https://jira.example.com/browse/ENG-1",
          ],
          {
            createClient: () =>
              new YavinClient({
                baseUrl: "http://yavin.test",
                apiKey: "yvn_x",
                fetch: async () => new Response("{}", { status: 200 }),
              }),
          },
        ),
      /__exit_1__/,
    );
    assert.deepEqual(exit.codes, [1]);
    assert.ok(
      captured.errs.some((l) => l.includes("--repo-config-id is required")),
      "expected helpful error message",
    );
  } finally {
    exit.restore();
    captured.restore();
  }
});

test("start: invalid --ticket-provider exits non-zero", async () => {
  const captured = captureConsole();
  const exit = stubExit();
  try {
    process.env.YAVIN_URL = "http://yavin.test";
    process.env.YAVIN_API_KEY = "yvn_x";
    await assert.rejects(
      () =>
        main(
          [
            "start",
            "fix",
            "https://x.example/abc",
            "--repo-config-id",
            "rc-1",
            "--ticket-provider",
            "monday",
          ],
          {
            createClient: () =>
              new YavinClient({
                baseUrl: "http://yavin.test",
                apiKey: "yvn_x",
                fetch: async () => new Response("{}", { status: 200 }),
              }),
          },
        ),
      /__exit_1__/,
    );
    assert.deepEqual(exit.codes, [1]);
    assert.ok(
      captured.errs.some((l) => l.includes("--ticket-provider must be one of")),
      "expected validation error",
    );
  } finally {
    exit.restore();
    captured.restore();
  }
});

test("start: HTTP error surfaces a usable message", async () => {
  const captured = captureConsole();
  const exit = stubExit();
  try {
    process.env.YAVIN_URL = "http://yavin.test";
    process.env.YAVIN_API_KEY = "yvn_x";
    const stubFetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "bad repo config" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      () =>
        main(
          [
            "start",
            "fix",
            "https://x.example/abc",
            "--repo-config-id",
            "rc-1",
          ],
          {
            createClient: () =>
              new YavinClient({
                baseUrl: "http://yavin.test",
                apiKey: "yvn_x",
                fetch: stubFetch,
              }),
          },
        ),
      /__exit_1__/,
    );
    assert.deepEqual(exit.codes, [1]);
    assert.ok(
      captured.errs.some((l) => l.includes("HTTP 400") && l.includes("bad repo config")),
      `expected HTTP 400 message, got: ${captured.errs.join(" | ")}`,
    );
  } finally {
    exit.restore();
    captured.restore();
  }
});
