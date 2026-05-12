import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  RUN_STATUSES,
  ResearchOutput,
  STAGE_KINDS,
} from "../protocol.js";

test("canTransition allows pending → researching", () => {
  assert.equal(canTransition("pending", "researching"), true);
});

test("canTransition rejects pending → completed", () => {
  assert.equal(canTransition("pending", "completed"), false);
});

test("RUN_STATUSES includes the canonical happy-path states", () => {
  for (const s of [
    "pending",
    "researching",
    "awaiting_research_approval",
    "planning",
    "completed",
  ]) {
    assert.ok(RUN_STATUSES.includes(s as (typeof RUN_STATUSES)[number]));
  }
});

test("STAGE_KINDS matches the 6-stage pipeline", () => {
  assert.deepEqual(
    [...STAGE_KINDS],
    ["research", "plan", "plan_review", "code", "code_review", "pr"],
  );
});

test("ResearchOutput zod schema parses a valid brief", () => {
  const parsed = ResearchOutput.parse({
    brief: "hello",
    citations: [{ url: "https://example.com", title: "Example" }],
  });
  assert.equal(parsed.brief, "hello");
  assert.equal(parsed.citations[0]?.url, "https://example.com");
});
