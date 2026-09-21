import test from "node:test";
import assert from "node:assert/strict";
import { effectiveInlineLanguages } from "./session";

test("the agent's own language choice passes through untouched", () => {
  assert.deepEqual(effectiveInlineLanguages(["de"]), ["de"]);
  assert.deepEqual(effectiveInlineLanguages(["en", "de"]), ["en", "de"]);
});

test("automatic detection falls back to English for test calls", () => {
  // Empty = the picker's Automatic mode (18-language detection every turn).
  // The test call locks to English instead; PSTN keeps raw config.
  assert.deepEqual(effectiveInlineLanguages([]), ["en"]);
  assert.deepEqual(effectiveInlineLanguages(undefined), ["en"]);
});

test("the fallback returns a copy, never the caller's array", () => {
  const codes = ["fr"];
  const out = effectiveInlineLanguages(codes);
  assert.notEqual(out, codes);
  assert.deepEqual(out, ["fr"]);
});
