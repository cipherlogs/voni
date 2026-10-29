import assert from "node:assert/strict";
import test from "node:test";
import { deleteRemoteAgent, stableJson } from "./provision";

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

test("the tenant stored body carries the voice's measured level", async () => {
  const { storedAgentBody, comparableAgent, deploymentFingerprint } = await import("./provision");
  const { REAL_ESTATE_TEMPLATE } = await import("./config");
  const { voiceOutputVolume } = await import("./voice-levels");

  const body = storedAgentBody("test-agent", REAL_ESTATE_TEMPLATE);
  assert.equal(typeof body.output.volume, "number", "the body carries a numeric output.volume");
  assert.equal(body.output.volume, voiceOutputVolume(REAL_ESTATE_TEMPLATE.voiceId));

  // Unknown voice: the builder still ships the named default, never a guess.
  const unmeasured = storedAgentBody("test-agent", { ...REAL_ESTATE_TEMPLATE, voiceId: "not-a-voice" });
  assert.equal(unmeasured.output.volume, voiceOutputVolume("not-a-voice"));

  // The tenant fingerprint input covers the level: changing only the volume
  // changes the hashed body, so a level change cannot hide behind a stale cache.
  const base = comparableAgent(body);
  const attenuated = comparableAgent({ ...body, output: { ...body.output, volume: body.output.volume - 1 } });
  assert.notEqual(stableJson(attenuated), stableJson(base), "the level is inside the fingerprint input");
  assert.deepEqual(
    { ...attenuated, output: base.output },
    base,
    "nothing but the level changed",
  );
  assert.notEqual(
    deploymentFingerprint("test-agent", { ...REAL_ESTATE_TEMPLATE, voiceId: "anna" }),
    deploymentFingerprint("test-agent", { ...REAL_ESTATE_TEMPLATE, voiceId: "lola" }),
    "different voices ship different bodies (and levels) as different fingerprints",
  );
});
