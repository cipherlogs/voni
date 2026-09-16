import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as calls-index.test.ts): the route
// needs a session plus database, so org-scoping, column hygiene, and the
// signed-out gate are checked on the real source.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "route.ts"), "utf8");

test("recent activity is signed-in only", () => {
  assert.match(source, /getCtx/);
  assert.match(source, /status: 401/);
});

test("recent activity reuses the org-scoped call list", () => {
  assert.match(source, /listCalls\(1, 5\)/);
});

test("recent activity returns display-safe columns only", () => {
  // Slice to the response mapping: the header comment names the excluded
  // columns, so only the mapping itself is asserted here.
  const body = source.slice(source.indexOf("rows.map"));
  assert.match(body, /id: call\.id/);
  assert.match(body, /name: call\.name/);
  assert.match(body, /direction: call\.direction/);
  assert.doesNotMatch(body, /call\.phone/);
  assert.doesNotMatch(body, /transcript/);
});
