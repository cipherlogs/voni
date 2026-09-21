import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as activity/recent/route.test.ts):
// the route needs a session, so the signed-out gate is checked on the real
// source while decision logic is unit-tested in voice-judge.test.ts.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "route.ts"), "utf8");

test("voice judge is signed-in only", () => {
  assert.match(source, /getCtx/);
  assert.match(source, /status: 401/);
});

test("voice judge never lets gateway failure fail the call", () => {
  assert.match(source, /tryJevGateway/);
  assert.match(source, /decideVoiceJudge/);
});

test("voice judge validates the request body", () => {
  assert.match(source, /parseVoiceJudgeRequest/);
  assert.match(source, /status: 400/);
});
