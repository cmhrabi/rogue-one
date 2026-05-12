import { test } from "node:test";
import assert from "node:assert/strict";
import { YavinApiError, YavinClient, type FetchLike } from "../yavin/client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("getHealth does NOT send Authorization header", async () => {
  let seenAuth: string | null = "absent";
  const stubFetch: FetchLike = async (_url, init) => {
    const h = new Headers(init?.headers);
    seenAuth = h.get("authorization");
    return jsonResponse(200, { ok: true });
  };
  const client = new YavinClient({
    baseUrl: "http://test.local",
    apiKey: "yvn_x",
    fetch: stubFetch,
  });
  const res = await client.getHealth();
  assert.deepEqual(res, { ok: true });
  assert.equal(seenAuth, null, "no Authorization header expected on /api/health");
});

test("whoami DOES send Authorization: Bearer <key>", async () => {
  let seenAuth: string | null = null;
  const stubFetch: FetchLike = async (_url, init) => {
    const h = new Headers(init?.headers);
    seenAuth = h.get("authorization");
    return jsonResponse(200, {
      kind: "apiKey",
      userId: "u1",
      keyId: "k1",
      label: "laptop",
    });
  };
  const client = new YavinClient({
    baseUrl: "http://test.local",
    apiKey: "yvn_abc",
    fetch: stubFetch,
  });
  const res = await client.whoami();
  assert.equal(res.userId, "u1");
  assert.equal(seenAuth, "Bearer yvn_abc");
});

test("5xx triggers exactly one retry then throws", async () => {
  let calls = 0;
  const stubFetch: FetchLike = async () => {
    calls += 1;
    return jsonResponse(503, { error: "down" });
  };
  const client = new YavinClient({
    baseUrl: "http://test.local",
    apiKey: "yvn_x",
    fetch: stubFetch,
    retryBaseMs: 1, // keep the test fast
  });
  await assert.rejects(() => client.whoami(), (err: unknown) => {
    assert.ok(err instanceof YavinApiError);
    assert.equal((err as YavinApiError).status, 503);
    return true;
  });
  assert.equal(calls, 2, "expected exactly two fetch attempts (initial + 1 retry)");
});

test("4xx throws YavinApiError immediately without retry, parsing JSON body", async () => {
  let calls = 0;
  const stubFetch: FetchLike = async () => {
    calls += 1;
    return jsonResponse(400, { error: "bad ticket url" });
  };
  const client = new YavinClient({
    baseUrl: "http://test.local",
    apiKey: "yvn_x",
    fetch: stubFetch,
  });
  await assert.rejects(
    () =>
      client.createRun({
        ticketProvider: "linear",
        ticketId: "ABC-1",
        ticketUrl: "https://linear.app/x/ABC-1",
        instructions: "test",
      }),
    (err: unknown) => {
      assert.ok(err instanceof YavinApiError);
      assert.equal((err as YavinApiError).status, 400);
      assert.deepEqual((err as YavinApiError).body, { error: "bad ticket url" });
      return true;
    },
  );
  assert.equal(calls, 1, "no retry expected on 4xx");
});

test("5xx then 200 succeeds after one retry", async () => {
  let calls = 0;
  const stubFetch: FetchLike = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(502, { error: "transient" });
    return jsonResponse(200, { ok: true });
  };
  const client = new YavinClient({
    baseUrl: "http://test.local",
    apiKey: "yvn_x",
    fetch: stubFetch,
    retryBaseMs: 1,
  });
  const res = await client.getHealth();
  assert.deepEqual(res, { ok: true });
  assert.equal(calls, 2);
});
