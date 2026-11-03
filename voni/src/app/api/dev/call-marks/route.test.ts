/**
 * Dev-only call-marks sink. The route must refuse production by name, validate
 * with the shared artifact validator, and hand every write to the disk store
 * (path rules live there).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "route.ts"), "utf8");

test("call marks route: inert in production by name", () => {
  assert.match(source, /NODE_ENV === "production"/);
  assert.match(source, /CALL_MARKS_PRODUCTION_REFUSAL/);
  assert.match(source, /status: 404/);
});

test("call marks route: writes through the store, never its own path logic", () => {
  assert.match(source, /writeCallMarks/);
  assert.doesNotMatch(source, /node:fs/);
});

test("call marks route: the shared validator guards the body", () => {
  assert.match(source, /isCallMarksArtifact/);
  assert.match(source, /status: 400/);
});

test("call marks route: the artifact must carry the call id in the query", () => {
  assert.match(source, /searchParams\.get\("callId"\)/);
});
