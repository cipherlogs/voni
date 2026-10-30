import test from "node:test";
import assert from "node:assert/strict";

import { demoMint, DEMO_MINT_FIELDS, DEMO_MINT_PATH, DEMO_MINT_UNAVAILABLE } from "./demo-mint";
import { RateLimitError } from "./session";
import { VoiceStartError } from "./mic-capture";

/**
 * The client door to the public demo (demo-cascade ticket 10).
 *
 * The request and the response are the seam: the mint route is faked at
 * `fetch`, so these tests pin what the browser sends and what it accepts
 * without a server, a rate-limit store or a pipeline.
 */

const MINTED = {
  engine: "cascade",
  wsUrl: "wss://pipeline.example.com/v1/browser-call",
  agentId: "demo:audrey",
  callToken: "ct1.call-token",
  demoCallToken: "call-id.1761771700.tag-id.mac",
  testTag: "Lime 42",
  tagToken: "tag-token",
  tagCarried: false,
  maxSessionSeconds: 720,
} as const;

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fetchStub(reply: Response): { calls: Array<{ url: string; init: RequestInit }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply;
  }) as typeof fetch;
  return { calls, fetch: stub };
}

test("the demo mint returns exactly the nine fields the route promises", async () => {
  const http = fetchStub(response(MINTED));
  const minted = await demoMint(
    "audrey",
    { resume: true, callToken: MINTED.demoCallToken, tagToken: "tag-token" },
    { fetch: http.fetch },
  );

  assert.deepEqual(Object.keys(minted).sort(), [...DEMO_MINT_FIELDS].sort());
  assert.equal(minted.engine, "cascade");
  assert.equal(minted.wsUrl, MINTED.wsUrl);
  assert.equal(minted.callToken, "ct1.call-token");
  assert.equal(minted.demoCallToken, MINTED.demoCallToken);

  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, DEMO_MINT_PATH);
  assert.equal(http.calls[0].init.method, "POST");
  assert.equal(
    (http.calls[0].init.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
  assert.deepEqual(JSON.parse(String(http.calls[0].init.body)), {
    voiceId: "audrey",
    resume: true,
    callToken: MINTED.demoCallToken,
    tagToken: "tag-token",
  });
});

test("a fresh demo call carries no previous call token", async () => {
  const http = fetchStub(response(MINTED));
  await demoMint("audrey", { resume: false }, { fetch: http.fetch });
  assert.deepEqual(JSON.parse(String(http.calls[0].init.body)), { voiceId: "audrey" });
});

test("a 429 keeps the countdown from Retry-After", async () => {
  const http = fetchStub(
    response({ error: "Too many demo calls right now." }, 429, { "Retry-After": "42" }),
  );
  await assert.rejects(
    demoMint("audrey", {}, { fetch: http.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError, "the UI can render a countdown");
      assert.equal(error.retryAfterSeconds, 42);
      assert.equal(error.message, "Too many demo calls right now.");
      return true;
    },
  );
});

test("a 429 without a usable Retry-After falls back to one minute", async () => {
  const http = fetchStub(response({ error: "Slow down." }, 429));
  await assert.rejects(demoMint("audrey", {}, { fetch: http.fetch }), (error: unknown) => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.retryAfterSeconds, 60);
    return true;
  });
});

test("a 503 keeps the route's unavailable line for the visitor", async () => {
  const http = fetchStub(response({ error: DEMO_MINT_UNAVAILABLE }, 503));
  await assert.rejects(demoMint("audrey", {}, { fetch: http.fetch }), (error: unknown) => {
    assert.ok(error instanceof VoiceStartError);
    assert.equal(error.code, "network");
    assert.equal(error.message, DEMO_MINT_UNAVAILABLE);
    return true;
  });
});

test("an old managed-token response cannot boot a managed call", async () => {
  // The pre-ticket-09 shape: a vendor session token and no pipeline URL.
  const http = fetchStub(
    response({ token: "vendor-token", agentId: "agent_demo", callToken: "demo-token" }),
  );
  await assert.rejects(demoMint("audrey", {}, { fetch: http.fetch }), (error: unknown) => {
    assert.ok(error instanceof VoiceStartError);
    assert.equal(error.code, "config");
    assert.equal(error.message, DEMO_MINT_UNAVAILABLE);
    return true;
  });
});

test("a response without the minted identity is refused, never half-used", async () => {
  const http = fetchStub(response({ ...MINTED, wsUrl: "" }));
  await assert.rejects(demoMint("audrey", {}, { fetch: http.fetch }), (error: unknown) => {
    assert.ok(error instanceof VoiceStartError);
    assert.equal(error.code, "config");
    return true;
  });
});
