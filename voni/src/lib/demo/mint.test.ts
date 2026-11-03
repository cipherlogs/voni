import test from "node:test";
import assert from "node:assert/strict";
import { createDemoTokenHandler, type MintDeps } from "./mint";
import { buildDemoCascadeBody } from "./cascade-body";
import { deliveryMessage, type DeliverCallBodyInput, type DeliveryResult } from "./pipeline-delivery";
import { CALL_TOKEN_TTL_S, signDemoCall, verifyDemoCall } from "./call-token";
import { checkDemoLimits } from "./rate-limit";
import { DELIVERY_REFUSAL_CODES } from "./pipeline-delivery";
import type { TestTagRow } from "./test-tag-registry";
import { WALL_CAP_S } from "./talk-clock";
import { verifyCallToken } from "@/lib/voice/cascade-token";
import { PipelineUrlError, type PipelineUrlResult } from "@/lib/voice/pipeline-url";
import { VONI_GREETINGS } from "./voni-agent";

/**
 * The public demo mint (demo-cascade ticket 09) is tested at the request and
 * response seam: a `Request` in, the visitor's JSON out. The rate-limit store,
 * the tag registry, the call record and the pipeline are fakes, so the test
 * never needs a database, a network or a running service.
 */

process.env.VOICE_PIPELINE_ENVELOPE_SECRET = "test-only-envelope-secret";
// The demo body always names its model, so the builder reads the Meta key the
// override carries. This is a fake; nothing here reaches a vendor.
process.env.META_API_KEY = "test-meta-key";
delete process.env.META_REASONING_EFFORT;
delete process.env.DEMO_LLM_MODEL_OVERRIDE;

const KEY = "test-only-demo-call-key";
const ENVELOPE_SECRET = "test-only-envelope-secret";
const NOW = 1_761_771_100_000;
const BASE = "https://pipeline.example.com";
const WS = "wss://pipeline.example.com/v1/browser-call";

const TAG = {
  id: "tag-held",
  tag: "Lime 42",
  language: "en",
  issuedAt: new Date(NOW - 60_000),
  expiresAt: new Date(NOW + 24 * 3600_000),
  matchedFrom: null,
  matchedMessageId: null,
  matchedThreadId: null,
  matchedAt: null,
  linkedTagId: null,
} as TestTagRow;

const RESPONSE_FIELDS = [
  "agentId",
  "callToken",
  "demoCallToken",
  "engine",
  "maxSessionSeconds",
  "tagCarried",
  "tagToken",
  "testTag",
  "wsUrl",
];

function freshTag(language: string, n: number): TestTagRow {
  return { ...TAG, id: `tag-fresh-${n}`, tag: `Fresh ${n}`, language };
}

type Harness = {
  handler: (request: Request) => Promise<Response>;
  issued: string[];
  recorded: Array<{ callId: string; tagId: string | null; language: string }>;
  deliveries: DeliverCallBodyInput[];
};

function harness(overrides: Partial<MintDeps> = {}): Harness {
  const issued: string[] = [];
  const recorded: Harness["recorded"] = [];
  const deliveries: DeliverCallBodyInput[] = [];
  const tagRows = new Map<string, TestTagRow>([[TAG.id, TAG]]);

  const deps: MintDeps = {
    limits: async () => ({ allowed: true }),
    tags: {
      load: async (id) => tagRows.get(id) ?? null,
      issue: async (language) => {
        const row = freshTag(language, issued.length + 1);
        issued.push(language);
        tagRows.set(row.id, row);
        return row;
      },
    },
    recordCall: async (callId, tagId, language) => {
      recorded.push({ callId, tagId, language });
    },
    buildBody: buildDemoCascadeBody,
    deliver: async (input) => {
      deliveries.push(input);
      return {
        ok: true,
        callId: input.callId,
        agentId: "demo:audrey",
        bodyHash: "a1".repeat(32),
      } satisfies DeliveryResult;
    },
    pipelineUrl: async (): Promise<PipelineUrlResult> => ({
      ok: true,
      baseUrl: BASE,
      wsUrl: WS,
    }),
    clock: () => NOW,
    callKey: async () => KEY,
    ...overrides,
  };

  return { handler: createDemoTokenHandler(deps), issued, recorded, deliveries };
}

function mintRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.com/api/demo/token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("one mint builds the body locally, delivers it, and returns the cascade contract", async () => {
  const app = harness();
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    throw new Error(`unexpected outbound fetch: ${String(url)}`);
  }) as typeof fetch;

  let response: Response;
  try {
    response = await app.handler(mintRequest({ voiceId: "audrey" }));
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await readJson(response);

  assert.deepEqual(Object.keys(payload).sort(), RESPONSE_FIELDS);
  assert.equal(payload.engine, "cascade");
  assert.equal(payload.wsUrl, WS);
  assert.equal(payload.agentId, "demo:audrey");
  assert.equal(payload.maxSessionSeconds, WALL_CAP_S);

  // The browser gets the cascade call token; the demo call token is the old
  // body-scoped credential, kept for the tools and the hold carry.
  assert.match(String(payload.callToken), /^ct1\./);
  const demoCall = verifyDemoCall(KEY, String(payload.demoCallToken), NOW);
  assert.ok(demoCall, "the demo call token verifies");

  // The signed body is the app's, built by the one builder and delivered once.
  assert.equal(app.deliveries.length, 1);
  const [delivered] = app.deliveries;
  assert.equal(delivered.pipelineBase, BASE);
  assert.equal(delivered.callToken, payload.callToken);
  assert.equal(delivered.callId, demoCall.callId);
  const envelope = (delivered.signedBody as { envelope: Record<string, unknown> }).envelope;
  const body = (delivered.signedBody as { body: Record<string, unknown> }).body;
  assert.equal(envelope.version, 2);
  assert.equal(envelope.kind, "demo");
  assert.equal(envelope.agent_id, "demo:audrey");
  assert.equal(body.greeting, VONI_GREETINGS.en);

  // The call token is bound to this call and this subject.
  assert.ok(
    verifyCallToken(String(payload.callToken), {
      secret: ENVELOPE_SECRET,
      callId: demoCall.callId,
      subject: "demo:audrey",
      now: NOW,
    }),
  );

  // The tag is fresh, the call is recorded, and nothing reached a vendor.
  assert.deepEqual(app.issued, ["en"]);
  assert.equal(payload.testTag, "Fresh 1");
  assert.equal(payload.tagCarried, false);
  assert.deepEqual(app.recorded, [
    { callId: demoCall.callId, tagId: "tag-fresh-1", language: "en" },
  ]);
  assert.deepEqual(fetched, [], "the mint makes no outbound fetch of its own");

  // The visitor's response never carries the body, the signature or the secret.
  const text = JSON.stringify(payload);
  assert.equal(text.includes(String(envelope.signature)), false);
  assert.equal(text.includes(ENVELOPE_SECRET), false);
  assert.equal(text.includes("system_prompt"), false);
});

test("the subject is the picked demo voice, and no tenant or arbitrary subject can mint", async () => {
  for (const voiceId of ["audrey"]) {
    const app = harness();
    const response = await app.handler(mintRequest({ voiceId }));
    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.agentId, `demo:${voiceId}`);
    assert.equal(app.deliveries.length, 1);
  }

  // Withdrawn demo voices are refused like any unknown voice: English only.
  for (const voiceId of ["malvina", "donatien", "jorg", "benicio", "tenant:acme", "acme", "", undefined, 42]) {
    const app = harness();
    const response = await app.handler(mintRequest({ voiceId }));
    assert.equal(response.status, 400, `voice ${JSON.stringify(voiceId)} is refused`);
    const payload = await readJson(response);
    assert.equal(typeof payload.error, "string");
    assert.equal(app.deliveries.length, 0);
    assert.equal(app.issued.length, 0, "a refused voice issues no tag");
    assert.equal(app.recorded.length, 0);
  }
});

/** The rate-limit store as the mint sees it: a counter per bucket. */
function countingStore() {
  const counts = new Map<string, number>();
  return {
    counts,
    bump: async (bucket: string, limit: number) => {
      const count = (counts.get(bucket) ?? 0) + 1;
      counts.set(bucket, count);
      return { ok: count <= limit, count };
    },
  };
}

test("per-IP and global limits each refuse with 429 and Retry-After", async () => {
  const cases = [
    {
      name: "per-IP",
      limits: { perIp: 1, perDay: 60 },
      error: "You've used your 1 demo calls this hour. Try again later.",
    },
    {
      name: "global",
      limits: { perIp: 60, perDay: 1 },
      error: "The demo has hit today's limit. Try again tomorrow.",
    },
  ];

  for (const c of cases) {
    const store = countingStore();
    const app = harness({
      // The real ceiling logic, over a fake store: no database, both ceilings.
      limits: (headers) =>
        checkDemoLimits(headers, {
          bump: store.bump,
          envInt: async (name, fallback) =>
            name === "DEMO_MAX_PER_IP_PER_HOUR" ? c.limits.perIp : c.limits.perDay ?? fallback,
        }),
    });

    const first = await app.handler(mintRequest({ voiceId: "audrey" }, { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(first.status, 200, `${c.name}: the first call is allowed`);

    const refused = await app.handler(
      mintRequest({ voiceId: "audrey" }, { "x-forwarded-for": "203.0.113.9" }),
    );
    assert.equal(refused.status, 429, `${c.name}: the second call is refused`);
    assert.equal(refused.headers.get("retry-after"), "3600");
    assert.equal(refused.headers.get("cache-control"), "no-store");
    assert.equal((await readJson(refused)).error, c.error);
    assert.equal(app.deliveries.length, 1, `${c.name}: a refused call never reaches the pipeline`);
  }
});

test("every pipeline refusal is a 503 with one visitor-facing line and no body", async () => {
  for (const code of DELIVERY_REFUSAL_CODES) {
    const app = harness({
      deliver: async (input) => {
        app.deliveries.push(input);
        return { ok: false, code, message: deliveryMessage(code) };
      },
    });

    const response = await app.handler(mintRequest({ voiceId: "audrey" }));
    assert.equal(response.status, 503, `${code} is unavailable, never a managed call`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await readJson(response);
    assert.deepEqual(Object.keys(payload), ["error"]);
    assert.equal(payload.error, deliveryMessage(code));
    assert.doesNotMatch(
      String(payload.error),
      /pipeline|cascade|engine|vendor|assemblyai|managed|secret|signature|envelope|HTTP|[45]\d\d/i,
      `${code}: the visitor line names no engine`,
    );
    // Nothing the service should keep is echoed back to the browser.
    const text = JSON.stringify(payload);
    assert.equal(text.includes(ENVELOPE_SECRET), false);
    assert.equal(text.includes("system_prompt"), false);
  }
});

test("a missing, invalid or insecure pipeline URL is the same 503", async () => {
  for (const code of ["missing", "invalid", "insecure"] as const) {
    const app = harness({
      pipelineUrl: async () => ({
        ok: false,
        error: new PipelineUrlError(code, `${code} configuration`),
      }),
    });

    const response = await app.handler(mintRequest({ voiceId: "audrey" }));
    assert.equal(response.status, 503, `${code} is unavailable`);
    const payload = await readJson(response);
    assert.deepEqual(payload, { error: "The live demo is not available right now." });
    assert.equal(app.deliveries.length, 0, `${code}: nothing is delivered`);
    assert.deepEqual(app.issued, [], `${code}: no tag is issued`);
    assert.equal(app.recorded.length, 0, `${code}: no call is recorded`);
  }
});

test("a carried tag keeps its id, its token and its email", async () => {
  const app = harness();
  const first = await readJson(await app.handler(mintRequest({ voiceId: "audrey" })));
  const heldToken = String(first.tagToken);

  const second = await readJson(
    await app.handler(mintRequest({ voiceId: "audrey", tagToken: heldToken })),
  );

  assert.equal(second.testTag, first.testTag, "the same tag comes back");
  assert.equal(second.tagToken, heldToken, "same id and issue time, so the same token");
  assert.equal(second.tagCarried, true);
  assert.notEqual(second.demoCallToken, first.demoCallToken, "a new call, the tag carried");
  assert.deepEqual(app.issued, ["en"], "a carried tag issues nothing new");
});

test("a hold rejoin keeps the call id and drops the greeting", async () => {
  // The visitor comes back a little later: the old token is still live, but
  // the return signs a fresh one for the same call.
  let now = NOW;
  const app = harness({ clock: () => now });
  const first = await readJson(await app.handler(mintRequest({ voiceId: "audrey" })));
  const callId = verifyDemoCall(KEY, String(first.demoCallToken), now)?.callId;
  assert.ok(callId);
  const history = [
    { role: "user", content: "We bake bread downtown." },
    { role: "assistant", content: "Lovely — whereabouts?" },
  ];
  now = NOW + 30_000;

  const second = await readJson(
    await app.handler(
      mintRequest({
        voiceId: "audrey",
        resume: true,
        callToken: first.demoCallToken,
        tagToken: first.tagToken,
        history,
      }),
    ),
  );

  assert.notEqual(second.demoCallToken, first.demoCallToken, "a fresh token, never the old one");
  assert.equal(verifyDemoCall(KEY, String(second.demoCallToken), now)?.callId, callId);
  assert.equal(
    verifyDemoCall(KEY, String(second.demoCallToken), now)?.startedAt,
    NOW,
    "the hold return keeps the call's first start (the inbox lookback does not move)",
  );
  assert.notEqual(second.callToken, first.callToken, "a fresh single-use call token");
  assert.equal(second.agentId, "demo:audrey");
  assert.equal(second.testTag, first.testTag);
  assert.deepEqual(
    [...new Set(app.recorded.map((row) => row.callId))],
    [callId],
    "one call id, one row",
  );

  // A second hold return continues from the returned token: the start is
  // still the call's, and each return is a new token.
  now = NOW + 60_000;
  const third = await readJson(
    await app.handler(
      mintRequest({
        voiceId: "audrey",
        resume: true,
        callToken: second.demoCallToken,
        tagToken: second.tagToken,
        history,
      }),
    ),
  );
  assert.notEqual(third.demoCallToken, second.demoCallToken, "every return signs fresh");
  assert.equal(verifyDemoCall(KEY, String(third.demoCallToken), now)?.callId, callId);
  assert.equal(
    verifyDemoCall(KEY, String(third.demoCallToken), now)?.startedAt,
    NOW,
    "a chain of holds never resets the start",
  );
  assert.deepEqual(
    [...new Set(app.recorded.map((row) => row.callId))],
    [callId],
    "still one call id and one row",
  );

  const [firstDelivery, secondDelivery] = app.deliveries;
  assert.equal(secondDelivery.callId, callId, "the delivery names the resumed call");
  const resumedBody = (secondDelivery.signedBody as { body: Record<string, unknown> }).body;
  assert.equal("greeting" in resumedBody, false, "the welcome-back is the first utterance");
  assert.deepEqual(resumedBody.history, history, "the recent turns ride in the signed body");
  const freshBody = (firstDelivery.signedBody as { body: Record<string, unknown> }).body;
  assert.equal(freshBody.greeting, VONI_GREETINGS.en);
  assert.equal("history" in freshBody, false, "a fresh call starts blank");
});

test("a hold return with a changed tag keeps the call id, issues a fresh token and one row", async () => {
  const app = harness();
  const first = await readJson(await app.handler(mintRequest({ voiceId: "audrey" })));
  const callId = verifyDemoCall(KEY, String(first.demoCallToken), NOW)?.callId;
  assert.ok(callId);

  // The visitor's tag is gone (a cleared store or an expired token): the mint
  // issues a different tag. That must not silently start a second call.
  const second = await readJson(
    await app.handler(
      mintRequest({
        voiceId: "audrey",
        resume: true,
        callToken: first.demoCallToken,
      }),
    ),
  );

  assert.notEqual(second.testTag, first.testTag, "the tag changed");
  assert.notEqual(second.demoCallToken, first.demoCallToken, "a fresh demo token");
  assert.equal(
    verifyDemoCall(KEY, String(second.demoCallToken), NOW)?.callId,
    callId,
    "resume always continues the held call id",
  );
  assert.notEqual(second.callToken, first.callToken, "a fresh single-use cascade token");
  assert.equal(app.deliveries[1].callId, callId, "the delivery names the resumed call");

  // Both mints name the same call, so the insert's conflict rule leaves one row.
  const recordedIds = new Set(app.recorded.map((row) => row.callId));
  assert.deepEqual([...recordedIds], [callId], "one call row, never a second call");
});

test("a rejoin without a valid previous call token is refused, not guessed", async () => {
  const expired = signDemoCall(KEY, NOW - CALL_TOKEN_TTL_S * 1000 - 60_000, null);
  const absent = undefined;
  const forged = signDemoCall("another-key", NOW, null);

  for (const callToken of [absent, forged, expired]) {
    const app = harness();
    const response = await app.handler(
      mintRequest({ voiceId: "audrey", resume: true, callToken }),
    );
    assert.equal(response.status, 400, `rejoin with ${String(callToken)} is refused`);
    const payload = await readJson(response);
    assert.equal(typeof payload.error, "string");
    assert.equal(app.deliveries.length, 0, "nothing is delivered");
    assert.deepEqual(app.issued, [], "no tag is issued");
    assert.equal(app.recorded.length, 0);
  }
});

test("a bad request body is refused before any tag, call or delivery", async () => {
  const app = harness();
  const response = await app.handler(
    new Request("https://app.example.com/api/demo/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await readJson(response), { error: "Bad request." });
  assert.deepEqual(app.issued, []);
  assert.equal(app.deliveries.length, 0);

  const nullBody = await app.handler(
    new Request("https://app.example.com/api/demo/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }),
  );
  assert.equal(nullBody.status, 400);
});

test("a call-record failure is a warning, never a refused call", async () => {
  const app = harness({
    recordCall: async () => {
      throw new Error("database unavailable");
    },
  });

  const response = await app.handler(mintRequest({ voiceId: "audrey" }));

  assert.equal(response.status, 200);
  assert.equal(app.deliveries.length, 1);
  assert.equal((await readJson(response)).engine, "cascade");
});
