import assert from "node:assert/strict";
import test from "node:test";
import { signDemoCall, verifyDemoCall } from "./call-token";
import { resolveDemoToolCall, type DemoCallLookup } from "./tool-credential";

const CALL_KEY = "demo-call-test-key";
const TOOL_SECRET = "service-tool-test-secret";

test.before(() => {
  process.env.BETTER_AUTH_SECRET = CALL_KEY;
  process.env.VONI_TOOL_SECRET = TOOL_SECRET;
});

test.after(() => {
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.VONI_TOOL_SECRET;
});

function toolRequest(authorization: string | null, body: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  return new Request("http://localhost/api/demo/tools/check_code", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function serviceBody(callId: string, args: Record<string, unknown> = { code: "1234" }) {
  return {
    toolCallId: "call_abc123",
    arguments: args,
    context: { kind: "call", callId },
  };
}

test("the browser's demo call token and the service's shared secret resolve the same call", async () => {
  // A browser token minted for one call: its id and tag are what the service
  // path must also produce, from the demo_calls row.
  const token = signDemoCall(CALL_KEY, Date.now(), "33333333-3333-4333-8333-333333333333");
  const browserCall = verifyDemoCall(CALL_KEY, token);
  assert.ok(browserCall);

  const lookup: DemoCallLookup = async (callId) => (callId === browserCall.callId ? browserCall : null);

  const browser = await resolveDemoToolCall(
    toolRequest(`Bearer ${token}`, { toolCallId: "call_abc123", arguments: { code: "1234" } }),
    lookup,
  );
  const service = await resolveDemoToolCall(
    toolRequest(`Bearer ${TOOL_SECRET}`, serviceBody(browserCall.callId)),
    lookup,
  );

  assert.ok(browser.ok);
  assert.ok(service.ok);
  assert.deepEqual(browser.call, service.call, "both credentials run the same DemoCall");
  assert.deepEqual(browser.args, service.args);
  assert.equal(browser.credential, "browser");
  assert.equal(service.credential, "service");
});

test("a wrong or missing credential is refused before any call is looked up", async () => {
  let lookups = 0;
  const lookup: DemoCallLookup = async () => {
    lookups += 1;
    return null;
  };
  const callId = "11111111-1111-4111-8111-111111111111";
  const requests: Array<[string, Request]> = [
    ["missing authorization", toolRequest(null, serviceBody(callId))],
    ["wrong secret", toolRequest("Bearer not-the-secret", serviceBody(callId))],
    ["wrong scheme", toolRequest(`bearer ${TOOL_SECRET}`, serviceBody(callId))],
    ["an unrelated bearer", toolRequest("Bearer some-other-token", serviceBody(callId))],
  ];

  for (const [label, request] of requests) {
    const result = await resolveDemoToolCall(request, lookup);
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.status, 401, label);
    assert.ok(!("call" in result), `${label}: no call reaches a handler`);
  }
  assert.equal(lookups, 0, "no lookup runs for a refused credential");
});

test("the service secret without a usable call id is a bad request, never a lookup", async () => {
  let lookups = 0;
  const lookup: DemoCallLookup = async () => {
    lookups += 1;
    return null;
  };
  const bodies: Array<[string, unknown]> = [
    ["no context", { toolCallId: "call_abc123", arguments: {} }],
    ["a test context", { toolCallId: "call_abc123", arguments: {}, context: { kind: "test", agentId: "11111111-1111-4111-8111-111111111111" } }],
    ["a call id that is empty", { toolCallId: "call_abc123", arguments: {}, context: { kind: "call", callId: "" } }],
    ["a call id that is not a uuid", { toolCallId: "call_abc123", arguments: {}, context: { kind: "call", callId: "../../calls" } }],
    ["no tool call id", { arguments: {}, context: { kind: "call", callId: "11111111-1111-4111-8111-111111111111" } }],
  ];

  for (const [label, body] of bodies) {
    const result = await resolveDemoToolCall(toolRequest(`Bearer ${TOOL_SECRET}`, body), lookup);
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.status, 400, label);
    assert.ok(!("call" in result), `${label}: no call reaches a handler`);
  }

  const malformed = new Request("http://localhost/api/demo/tools/check_code", {
    method: "POST",
    headers: { authorization: `Bearer ${TOOL_SECRET}`, "content-type": "application/json" },
    body: "{",
  });
  const result = await resolveDemoToolCall(malformed, lookup);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 400);

  assert.equal(lookups, 0, "no lookup runs for a malformed body");
});

test("an unknown or tenant call id is refused without reaching a handler", async () => {
  const demoCallId = "11111111-1111-4111-8111-111111111111";
  const unknownCallId = "22222222-2222-4222-8222-222222222222";
  const tenantCallId = "33333333-3333-4333-8333-333333333333";
  const demoCall = { callId: demoCallId, startedAt: 1_000_000, tagId: null };

  let lookups = 0;
  const lookup: DemoCallLookup = async (callId) => {
    lookups += 1;
    return callId === demoCallId ? demoCall : null;
  };

  for (const [label, callId] of [
    ["an id no demo call owns", unknownCallId],
    ["a tenant call id", tenantCallId],
  ] as const) {
    const result = await resolveDemoToolCall(toolRequest(`Bearer ${TOOL_SECRET}`, serviceBody(callId)), lookup);
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.status, 404, label);
    assert.ok(!("call" in result), `${label}: no call reaches a handler`);
  }
  assert.equal(lookups, 2, "the demo lookup is the only place an id resolves");
});

test("no refusal echoes either credential", async () => {
  const supplied = "wrong-secret-that-must-not-be-echoed";
  const callId = "11111111-1111-4111-8111-111111111111";
  const results = [
    await resolveDemoToolCall(toolRequest(`Bearer ${supplied}`, serviceBody(callId)), async () => null),
    await resolveDemoToolCall(toolRequest(`Bearer ${TOOL_SECRET}`, { toolCallId: "call_abc123", arguments: {} }), async () => null),
    await resolveDemoToolCall(toolRequest(`Bearer ${TOOL_SECRET}`, serviceBody(callId)), async () => null),
  ];

  for (const result of results) {
    const wire = JSON.stringify(result);
    assert.equal(result.ok, false);
    assert.ok(!wire.includes(TOOL_SECRET), "the shared secret never appears in a response");
    assert.ok(!wire.includes(supplied), "a supplied secret never appears in a response");
  }
});

test("the browser token path is unchanged: token first, then body", async () => {
  const token = signDemoCall(CALL_KEY, Date.now());
  const call = verifyDemoCall(CALL_KEY, token);
  assert.ok(call);
  let lookups = 0;
  const lookup: DemoCallLookup = async () => {
    lookups += 1;
    return null;
  };

  const badToken = await resolveDemoToolCall(
    toolRequest("Bearer not-a-call-token", { toolCallId: "call_abc123", arguments: {} }),
    lookup,
  );
  assert.equal(badToken.ok, false);
  if (!badToken.ok) assert.equal(badToken.status, 401);

  const badBody = await resolveDemoToolCall(
    toolRequest(`Bearer ${token}`, { arguments: {} }),
    lookup,
  );
  assert.equal(badBody.ok, false);
  if (!badBody.ok) assert.equal(badBody.status, 400);

  const good = await resolveDemoToolCall(
    toolRequest(`Bearer ${token}`, { toolCallId: "call_abc123", arguments: { code: "1234" } }),
    lookup,
  );
  assert.ok(good.ok);
  assert.equal(good.credential, "browser");
  assert.deepEqual(good.call, call);
  assert.deepEqual(good.args, { code: "1234" });
  assert.equal(lookups, 0, "the browser path never reads the demo_calls table");
});
