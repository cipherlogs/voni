import assert from "node:assert/strict";
import test from "node:test";
import { backoffMs } from "./llm-accounts";

test("backoff doubles per consecutive failure and caps at 30 minutes", () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(3), 120_000);
  assert.equal(backoffMs(10), 30 * 60_000);
});

test("backoff never goes below the base cooldown for non-positive counts", () => {
  assert.equal(backoffMs(0), 30_000);
  assert.equal(backoffMs(-5), 30_000);
});
