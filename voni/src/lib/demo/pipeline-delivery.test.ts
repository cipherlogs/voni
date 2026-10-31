import test from "node:test";
import assert from "node:assert/strict";
import { CALL_BODY_PATH, deliverCallBody, deliveryMessage } from "./pipeline-delivery";

/**
 * The delivery client (demo-cascade ticket 07) is tested at its one seam: the
 * bytes it puts on the wire and the typed result it hands the mint. The fake
 * fetch below is the pipeline; nothing here re-implements the client's own
 * mapping.
 */

const BASE = "https://pipeline.example.com";
const CALL_ID = "call_delivery_07";
const AGENT_ID = "demo:audrey";
const TOKEN = "ct1.delivery-payload.delivery-signature";
const SIGNATURE = "9f".repeat(32);

const CALL = {
  callToken: TOKEN,
  callId: CALL_ID,
  signedBody: {
    envelope: {
      version: 2,
      kind: "demo",
      call_id: CALL_ID,
      agent_id: AGENT_ID,
      body_hash: "a1".repeat(32),
      issued_at_ms: 1_761_771_100_000,
      expires_at_ms: 1_761_771_160_000,
      signature: SIGNATURE,
    },
    body: { name: "voni", system_prompt: "a body only the service should see" },
  },
};

type Recorded = { url: string; init: RequestInit };

function fakeFetch(
  respond: () => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record: typeof fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetch: record, calls };
}

function accepted(): Response {
  return new Response(
    JSON.stringify({
      status: "accepted",
      call_id: CALL_ID,
      agent_id: AGENT_ID,
      body_hash: "a1".repeat(32),
    }),
    { status: 202, headers: { "content-type": "application/json" } },
  );
}

test("one accepted delivery returns the pipeline's identity and sends exactly three fields", async () => {
  const pipeline = fakeFetch(accepted);

  const result = await deliverCallBody(
    { pipelineBase: BASE, ...CALL },
    { fetchImpl: pipeline.fetch },
  );

  assert.deepEqual(result, {
    ok: true,
    callId: CALL_ID,
    agentId: AGENT_ID,
    bodyHash: "a1".repeat(32),
  });
  // The body and the signed body are the service's now, not the client's.
  assert.deepEqual(Object.keys(result).sort(), [
    "agentId",
    "bodyHash",
    "callId",
    "ok",
  ]);
  assert.equal(JSON.stringify(result).includes(SIGNATURE), false);
  assert.equal(JSON.stringify(result).includes("system_prompt"), false);

  assert.equal(pipeline.calls.length, 1);
  const [call] = pipeline.calls;
  assert.equal(call.url, `${BASE}${CALL_BODY_PATH}`);
  assert.equal(call.init.method, "POST");
  assert.equal(
    (call.init.headers as Record<string, string>)["content-type"],
    "application/json",
  );

  const sent = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), [
    "call_id",
    "call_token",
    "signed_body",
  ]);
  assert.equal(sent.call_token, TOKEN);
  assert.equal(sent.call_id, CALL_ID);
  assert.deepEqual(sent.signed_body, CALL.signedBody);
});

const REFUSALS = [
  ["draining", 503],
  ["envelope_secret_missing", 503],
  ["malformed_body", 400],
  ["envelope_refused", 400],
  ["duplicate_call_token", 400],
  ["store_unavailable", 503],
] as const;

function refused(status: number, code: string): Response {
  return new Response(JSON.stringify({ detail: "the service's own prose" }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-cascade-refusal": code,
    },
  });
}

test("each named refusal maps to its own typed code and a visitor-safe line", async () => {
  const seen: string[] = [];
  for (const [code, status] of REFUSALS) {
    const pipeline = fakeFetch(() => refused(status, code));

    const result = await deliverCallBody(
      { pipelineBase: BASE, ...CALL },
      { fetchImpl: pipeline.fetch },
    );

    assert.equal(pipeline.calls.length, 1);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, code);
    assert.equal(result.message, deliveryMessage(code));
    assert.equal(result.message.trim() === "", false);
    // The service's prose and every technical word stay out of it.
    assert.doesNotMatch(
      result.message,
      /pipeline|cascade|engine|vendor|assemblyai|cartesia|meta\b|secret|signature|envelope|signed|service|detail|HTTP|[45]\d\d/i,
    );
    seen.push(result.code);
  }
  assert.deepEqual(seen, REFUSALS.map(([code]) => code));

  // Every code has its own line: no two refusals collapse into one blur.
  const lines = new Set(REFUSALS.map(([code]) => deliveryMessage(code)));
  assert.equal(lines.size, REFUSALS.length);
});

test("a thrown fetch is one transport failure, never retried", async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.1:8766");
  }) as typeof fetch;

  const result = await deliverCallBody(
    { pipelineBase: BASE, ...CALL },
    { fetchImpl },
  );

  assert.equal(attempts, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "transport_failure");
  assert.equal(result.message, deliveryMessage("transport_failure"));
  // The transport's own words stay out of the visitor's line.
  assert.doesNotMatch(result.message, /ECONNREFUSED|10\.0\.0\.1|fetch|connect/i);
});

test("an answer we cannot classify is a failed delivery, not a guessed refusal", async () => {
  const answers: Array<() => Response> = [
    () => new Response("upstream exploded", { status: 500 }),
    () => refused(400, "a_refusal_we_do_not_know"),
    () => new Response("not json", { status: 202 }),
    () =>
      new Response(JSON.stringify({ status: "accepted" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
  ];

  for (const answer of answers) {
    const pipeline = fakeFetch(answer);
    const result = await deliverCallBody(
      { pipelineBase: BASE, ...CALL },
      { fetchImpl: pipeline.fetch },
    );

    assert.equal(pipeline.calls.length, 1);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.code, "transport_failure");
    assert.equal(result.message, deliveryMessage("transport_failure"));
  }
});

test("no secret, body, signature or call token reaches a log line or a result", async () => {
  const captured: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const record = (...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  console.debug = record;

  const results: unknown[] = [];
  try {
    const answers: Array<() => Response> = [
      accepted,
      ...REFUSALS.map(([code, status]) => () => refused(status, code)),
      () => new Response("no", { status: 502 }),
    ];
    for (const answer of answers) {
      const pipeline = fakeFetch(answer);
      results.push(
        await deliverCallBody(
          { pipelineBase: BASE, ...CALL },
          { fetchImpl: pipeline.fetch },
        ),
      );
    }
    results.push(
      await deliverCallBody(
        { pipelineBase: BASE, ...CALL },
        {
          fetchImpl: (async () => {
            throw new Error(`boom ${SIGNATURE}`);
          }) as typeof fetch,
        },
      ),
    );
  } finally {
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
    console.debug = originals.debug;
  }

  assert.deepEqual(captured, []);
  const rendered = JSON.stringify(results);
  // The body hash is the accepted identity the mint keeps; the body itself,
  // its signature and the call token never leave this function in a result.
  for (const forbidden of [TOKEN, SIGNATURE, "system_prompt", "a body only"]) {
    assert.equal(rendered.includes(forbidden), false, forbidden);
  }
});
