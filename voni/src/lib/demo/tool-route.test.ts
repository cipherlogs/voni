import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions, the house pattern for routes that need a session or
// a live call (see api/voice-judge/route.test.ts): the credential and refusal
// behaviour is unit-tested at the resolver seam in tool-credential.test.ts,
// and this pins the wiring that makes both credentials reach the one dispatch
// block. Kept here, not beside the route, because the `[name]` route segment
// is a glob character class to `node --test`.
const here = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(join(here, "../../app/api/demo/tools/[name]/route.ts"), "utf8");
const lookupSource = readFileSync(join(here, "tool-call.ts"), "utf8");

test("the route resolves both credentials through one resolver", () => {
  assert.match(routeSource, /resolveDemoToolCall\(request, demoCallById\)/);
  assert.match(routeSource, /if \(!auth\.ok\)/);
  assert.match(routeSource, /status: auth\.status/);
  assert.match(routeSource, /error: auth\.error/);
});

test("both credentials run the same handlers: one dispatch, no per-credential branch", () => {
  for (const handler of [/runCheckEmail\(/, /runSendReply\(/, /runCheckCode\(/, /executeDemoTool\(/]) {
    const count = (routeSource.match(new RegExp(handler.source, "g")) ?? []).length;
    assert.equal(count, 1, `${handler.source} appears once, after the credential resolves`);
  }
  assert.doesNotMatch(routeSource, /credential ===/, "no handler is chosen by credential kind");
});

test("end_call stays an in-process signal, never an HTTP hop", () => {
  assert.doesNotMatch(routeSource, /end_call/);
  assert.doesNotMatch(routeSource, /fetch\(/);
});

test("the route never logs or echoes a credential", () => {
  assert.doesNotMatch(routeSource, /console\./);
});

test("the demo lookup reads only demo_calls, so a tenant call id cannot resolve", () => {
  assert.match(lookupSource, /import \{ demoCalls \} from "@\/lib\/db\/schema"/);
  assert.match(lookupSource, /eq\(demoCalls\.callId, callId\)/);
  assert.match(lookupSource, /from "@\/lib\/db"/);
});
