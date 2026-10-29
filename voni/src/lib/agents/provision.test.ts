import assert from "node:assert/strict";
import test from "node:test";
import { deleteRemoteAgent } from "./provision";

function response(status: number): Response {
  return new Response(null, { status });
}

test("deleteRemoteAgent maps 204 to deleted, 404 to already-gone", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response(204);
  }) as typeof fetch;

  const deleted = await deleteRemoteAgent("remote-1", {
    apiKey: "key",
    fetchFn,
  });
  assert.deepEqual(deleted, { ok: true, alreadyGone: false });
  assert.equal(
    calls[0].url,
    "https://agents.assemblyai.com/v1/agents/remote-1",
  );
  assert.equal(calls[0].init?.method, "DELETE");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer key",
  );

  const gone = await deleteRemoteAgent("remote-2", {
    apiKey: "key",
    fetchFn: (async () => response(404)) as typeof fetch,
  });
  assert.deepEqual(gone, { ok: true, alreadyGone: true });
});

test("deleteRemoteAgent fails closed on refusal, error, and transport failure", async () => {
  const refused = await deleteRemoteAgent("remote-1", {
    apiKey: "key",
    fetchFn: (async () => response(401)) as typeof fetch,
  });
  assert.deepEqual(refused, { ok: false, status: 401, reason: "refused" });

  const errored = await deleteRemoteAgent("remote-1", {
    apiKey: "key",
    fetchFn: (async () => response(500)) as typeof fetch,
  });
  assert.deepEqual(errored, { ok: false, status: 500, reason: "refused" });

  const transport = await deleteRemoteAgent("remote-1", {
    apiKey: "key",
    fetchFn: (async () => {
      throw new Error("boom");
    }) as typeof fetch,
  });
  assert.deepEqual(transport, { ok: false, status: 0, reason: "transport" });

  const noKey = await deleteRemoteAgent("remote-1", {
    apiKey: null,
    fetchFn: (async () => response(204)) as typeof fetch,
  });
  assert.deepEqual(noKey, { ok: false, status: 0, reason: "missing-key" });
});

test("deleteRemoteAgent encodes the remote id", async () => {
  let url = "";
  await deleteRemoteAgent("a/b?c", {
    apiKey: "key",
    fetchFn: (async (input: string | URL | Request) => {
      url = String(input);
      return response(204);
    }) as typeof fetch,
  });
  assert.equal(url, "https://agents.assemblyai.com/v1/agents/a%2Fb%3Fc");
});

test("storedAgentBody ships REST-shaped tools without `type`", async () => {
  const { storedAgentBody } = await import("./provision");
  const { REAL_ESTATE_TEMPLATE } = await import("./config");
  const body = storedAgentBody("test-agent", REAL_ESTATE_TEMPLATE);
  assert.ok(body.tools.length > 0, "tools ship on stored agents");
  assert.equal(body.tools.at(-1)?.name, "end_call", "call control last");
  for (const tool of body.tools as Array<Record<string, unknown>>) {
    assert.ok(!("type" in tool), "Agents REST API has no `type` field");
  }
});

test("the tenant phone body runs the Turn preset, not an explicit object", async () => {
  const { storedAgentBody } = await import("./provision");
  const { REAL_ESTATE_TEMPLATE } = await import("./config");

  // CONTEXT.md **Turn preset**: one turn-taking setting on every call. The
  // phone path is a profile of the one builder, so it sends `turn_detection:
  // null` (adaptive, meaning-based end-of-turn) like the browser demo.
  const body = storedAgentBody("test-agent", REAL_ESTATE_TEMPLATE);
  assert.ok("turn_detection" in body.input, "the body shape is unchanged");
  assert.equal(body.input.turn_detection, null);
  assert.equal(
    JSON.stringify(body).match(/"turn_detection":/g)?.length,
    1,
    "the tenant body never carries a second, explicit object",
  );
});

test("the tenant stored body carries the voice's measured level", async () => {
  const { storedAgentBody, deploymentFingerprint } = await import("./provision");
  const { agentBodyFingerprint } = await import("./fingerprint");
  const { REAL_ESTATE_TEMPLATE } = await import("./config");
  const { voiceOutputVolume } = await import("./voice-levels");

  const body = storedAgentBody("test-agent", REAL_ESTATE_TEMPLATE);
  assert.equal(typeof body.output.volume, "number", "the body carries a numeric output.volume");
  assert.equal(body.output.volume, voiceOutputVolume(REAL_ESTATE_TEMPLATE.voiceId));

  // Unknown voice: the builder still ships the named default, never a guess.
  const unmeasured = storedAgentBody("test-agent", { ...REAL_ESTATE_TEMPLATE, voiceId: "not-a-voice" });
  assert.equal(unmeasured.output.volume, voiceOutputVolume("not-a-voice"));

  // The tenant path hashes the whole body it built, so a level change cannot
  // hide behind a stale deployment: the level is inside the fingerprint.
  assert.equal(
    deploymentFingerprint("test-agent", REAL_ESTATE_TEMPLATE),
    agentBodyFingerprint(body),
    "the deployment fingerprint is the whole tenant body",
  );
  const attenuated = { ...body, output: { ...body.output, volume: body.output.volume - 1 } };
  assert.notEqual(agentBodyFingerprint(attenuated), agentBodyFingerprint(body), "the level is inside the fingerprint");
  assert.deepEqual(
    { ...attenuated, output: body.output },
    body,
    "nothing but the level changed",
  );
  assert.notEqual(
    deploymentFingerprint("test-agent", { ...REAL_ESTATE_TEMPLATE, voiceId: "anna" }),
    deploymentFingerprint("test-agent", { ...REAL_ESTATE_TEMPLATE, voiceId: "lola" }),
    "different voices ship different bodies (and levels) as different fingerprints",
  );
});

test("the deployment fingerprint covers the model override", async () => {
  const { buildStoredAgent } = await import("./body");
  const { agentBodyFingerprint } = await import("./fingerprint");
  const { storedAgentBody, tenantAgentProfile } = await import("./provision");
  const { REAL_ESTATE_TEMPLATE } = await import("./config");

  const llm = [
    { base_url: "https://llm.example.test/v1", model: "m", api_key: "sk-write-only" },
  ];
  const overridden = buildStoredAgent({
    name: "Layla",
    config: REAL_ESTATE_TEMPLATE,
    profile: { ...tenantAgentProfile(REAL_ESTATE_TEMPLATE), modelOverride: llm },
  });
  const managed = storedAgentBody("Layla", REAL_ESTATE_TEMPLATE);

  assert.notEqual(
    agentBodyFingerprint(overridden),
    agentBodyFingerprint(managed),
    "the override the tenant subset omitted is now inside the deployment fingerprint",
  );
  const { llm: _llm, ...rest } = overridden;
  void _llm;
  assert.deepEqual(rest, managed, "the override is the only difference");
});

test("a platform read-back compares equal to the body that was sent", async () => {
  const { buildStoredAgent } = await import("./body");
  const { agentBodyFingerprint, readBackAgentBody } = await import("./fingerprint");
  const { tenantAgentProfile } = await import("./provision");
  const { REAL_ESTATE_TEMPLATE } = await import("./config");

  const llm = [
    { base_url: "https://llm.example.test/v1", model: "m", api_key: "sk-write-only" },
  ];
  const body = buildStoredAgent({
    name: "Layla",
    config: REAL_ESTATE_TEMPLATE,
    profile: { ...tenantAgentProfile(REAL_ESTATE_TEMPLATE), modelOverride: llm },
  });

  // What GET /v1/agents/{id} adds or never returns: ids and timestamps, tool
  // ids, and the write-only LLM key. Nothing the body authors is dropped.
  const readBack = {
    ...body,
    id: "agent_123",
    created_at: "2026-10-29T00:00:00.000Z",
    updated_at: "2026-10-29T00:00:00.000Z",
    tools: body.tools.map((tool, index) => ({ ...tool, id: `tool_${index}`, last_set_at: "2026-10-29T00:00:00.000Z" })),
    llm: llm.map(({ api_key: _apiKey, ...entry }) => {
      void _apiKey;
      return entry;
    }),
  };

  assert.equal(
    agentBodyFingerprint(readBackAgentBody(readBack)),
    agentBodyFingerprint(readBackAgentBody(body)),
    "the ambiguous-create check hashes the read-back shape of both sides",
  );
  assert.deepEqual(
    readBackAgentBody(readBack),
    readBackAgentBody(body),
    "an ambiguous create can recognise the agent it just made",
  );
  assert.deepEqual(
    Object.keys(readBackAgentBody(body)).sort(),
    Object.keys(body).sort(),
    "the read-back shape keeps every authored field",
  );
  assert.notDeepEqual(
    readBackAgentBody({ ...readBack, system_prompt: `${readBack.system_prompt} Drifted.` }),
    readBackAgentBody(body),
    "a body the platform actually moved still compares different",
  );
});
