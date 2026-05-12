import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPrompt, type PromptName } from "./index.js";

test("loadPrompt('researcher') returns the prompt body with the required markers", () => {
  const body = loadPrompt("researcher");
  assert.equal(typeof body, "string");
  assert.ok(body.length > 0, "prompt body should be non-empty");
  // Marker substrings that pin the contract without freezing wording.
  for (const marker of ["citations", "path:line", "brief", "ResearchOutput"]) {
    assert.ok(
      body.includes(marker),
      `expected prompt to mention "${marker}"`,
    );
  }
});

test("loadPrompt caches successive reads (same string instance)", () => {
  const a = loadPrompt("researcher");
  const b = loadPrompt("researcher");
  assert.equal(a, b);
});

test("loadPrompt throws on unknown name", () => {
  assert.throws(
    () => loadPrompt("nope" as PromptName),
    /unknown prompt/,
  );
});
