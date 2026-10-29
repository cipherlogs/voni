import test from "node:test";
import assert from "node:assert/strict";
import { effectiveInlineLanguages } from "./session";

test("the agent's own language choice passes through untouched", () => {
  assert.deepEqual(effectiveInlineLanguages(["de"]), ["de"]);
  assert.deepEqual(effectiveInlineLanguages(["en", "de"]), ["en", "de"]);
});

test("the conversation Locale decides when the picker lists no code", () => {
  assert.deepEqual(effectiveInlineLanguages([], "es"), ["es"]);
  assert.deepEqual(effectiveInlineLanguages(undefined, "de"), ["de"]);
  // An unsupported Locale is not a code; automatic detection stays on.
  assert.equal(effectiveInlineLanguages(undefined, "xx"), undefined);
});

test("automatic detection stays automatic: no English code is pinned", () => {
  // Empty picker and no conversation Locale = the recogniser's own
  // 18-language detection every turn. ["en"] would switch it off.
  assert.equal(effectiveInlineLanguages([]), undefined);
  assert.equal(effectiveInlineLanguages(undefined), undefined);
  assert.equal(effectiveInlineLanguages(undefined, null), undefined);
});

test("the fallback returns a copy, never the caller's array", () => {
  const codes = ["fr"];
  const out = effectiveInlineLanguages(codes);
  assert.notEqual(out, codes);
  assert.deepEqual(out, ["fr"]);
});
