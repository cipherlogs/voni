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
