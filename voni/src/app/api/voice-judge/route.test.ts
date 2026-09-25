import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as activity/recent/route.test.ts):
// the route needs a session, so the signed-out gate is checked on the real
// source while decision logic is unit-tested in voice-judge.test.ts.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "route.ts"), "utf8");

test("voice judge accepts sessions and the bridge bearer", () => {
  assert.match(source, /getCtx/);
  assert.match(source, /VONI_TOOL_SECRET/);
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

test("voice judge reads secrets Worker-safe", () => {
  // secret() covers process.env + the Cloudflare context; a plain
  // process.env read would be undefined on the deployed Worker.
  assert.match(source, /secret\("AI_GATEWAY_API_KEY"\)/);
});

test("the signed-out demo judges off-track only, with its call token", () => {
  assert.match(source, /demoCallFromRequest/);
  assert.match(source, /demoOnly && parsed\.kind !== "off-track"/);
  assert.match(source, /status: 403/);
});
