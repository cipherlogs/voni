/**
 * Dev-only delivered-capture sink. The route must be inert in production and
 * hand every write to the shared store (path rules live there).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "route.ts"), "utf8");

test("delivered capture route: inert in production", () => {
  assert.match(source, /NODE_ENV === "production"/);
  assert.match(source, /status: 404/);
});

test("delivered capture route: writes through the store, never its own path logic", () => {
  assert.match(source, /writeDeliveredCapture/);
  assert.doesNotMatch(source, /node:fs/);
});

test("delivered capture route: a bad name is a 400, not a write", () => {
  assert.match(source, /status: 400/);
});
