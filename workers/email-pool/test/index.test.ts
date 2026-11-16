import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.ts";

const SECRET = "pool-secret-abc123";
const realFetch = globalThis.fetch;

const PROD_ENV = {
  POOL_SECRET: SECRET,
  ALLOWED_TARGET_HOSTS: "voni.cc,www.voni.cc,cipherlogs.github.io",
  POOL_INDEX: "0",
  POOL_USER_AGENT: "pool-test-agent/1.0",
};

const DEV_ENV = {
  ...PROD_ENV,
  ALLOWED_TARGET_HOSTS:
    "voni.cc,www.voni.cc,localhost:3000,127.0.0.1:3000,cipherlogs.github.io",
  ALLOW_PRIVATE_TARGETS: "true",
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return response();
  }) as typeof fetch;
  return seen;
}

function stubThrowingFetch(error: unknown): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as typeof fetch;
}

function clickRequest(
  body: unknown = { url: "https://voni.cc/test", visitId: "abc" },
  headers: Record<string, string> = { "x-pool-secret": SECRET },
): Request {
  return new Request("https://pool.example/click", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function healthRequest(): Request {
  return new Request("https://pool.example/health", { method: "GET" });
}

test("GET /health is public and reports worker, colo, allowlist", async () => {
  const response = await worker.fetch(healthRequest(), PROD_ENV);
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    worker: "email-pool-01",
    colo: "UNKNOWN",
    allowlist: ["voni.cc", "www.voni.cc", "cipherlogs.github.io"],
  });
});

test("the default allowlist is the three production hosts", async () => {
  const { ALLOWED_TARGET_HOSTS: _unset, ...envWithoutAllowlist } = PROD_ENV;

  const response = await worker.fetch(healthRequest(), envWithoutAllowlist);
  const body = (await response.json()) as { allowlist: string[] };

  assert.deepEqual(body.allowlist, [
    "voni.cc",
    "www.voni.cc",
    "cipherlogs.github.io",
  ]);
});

test("GET /health reflects the dev allowlist", async () => {
  const response = await worker.fetch(healthRequest(), DEV_ENV);
  const body = (await response.json()) as { allowlist: string[] };
  assert.deepEqual(body.allowlist, [
    "voni.cc",
    "www.voni.cc",
    "localhost:3000",
    "127.0.0.1:3000",
    "cipherlogs.github.io",
  ]);
});

test("POST /click without the secret is 401 unauthorized", async () => {
  const response = await worker.fetch(clickRequest(undefined, {}), PROD_ENV);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
});

test("POST /click with a wrong secret is 401 unauthorized", async () => {
  const response = await worker.fetch(
    clickRequest(undefined, { "x-pool-secret": "nope" }),
    PROD_ENV,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
});

test("POST /click rejects a foreign target with 400 bad_target", async () => {
  const response = await worker.fetch(
    clickRequest({ url: "https://evil.example/", visitId: "abc" }),
    PROD_ENV,
  );
  assert.equal(response.status, 400);

  const body = (await response.json()) as { ok: boolean; reason: string; detail: string };
  assert.equal(body.ok, false);
  assert.equal(body.reason, "bad_target");
  assert.match(body.detail, /ALLOWED_TARGET_HOSTS/);
});

test("POST /click rejects http on a production host", async () => {
  const response = await worker.fetch(
    clickRequest({ url: "http://voni.cc/test", visitId: "abc" }),
    PROD_ENV,
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { reason: string }).reason, "bad_target");
});

test("POST /click rejects a malformed JSON body", async () => {
  const response = await worker.fetch(clickRequest("{not json"), PROD_ENV);
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { reason: string }).reason, "bad_request");
});

test("POST /click returns the 200 shape on success", async () => {
  const seen = stubFetch(() => new Response("ok", { status: 200 }));

  const response = await worker.fetch(clickRequest(), PROD_ENV);
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.worker, "email-pool-01");
  assert.equal(body.colo, "UNKNOWN");
  assert.equal(body.ok, true);
  assert.equal(body.status, 200);
  assert.equal(body.location, null);
  assert.equal(body.reason, null);
  assert.equal(body.target, "https://voni.cc/test");
  assert.equal(typeof body.ms, "number");
  assert.deepEqual(seen, ["https://voni.cc/test"]);
});

test("POST /click accepts localhost:3000 in dev", async () => {
  const seen = stubFetch(() => new Response("ok", { status: 200 }));

  const response = await worker.fetch(
    clickRequest({ url: "http://localhost:3000/test", visitId: "abc" }),
    DEV_ENV,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["http://localhost:3000/test"]);
});

test("POST /click accepts the GitHub Pages target", async () => {
  const seen = stubFetch(() => new Response("ok", { status: 200 }));

  const response = await worker.fetch(
    clickRequest({
      url: "https://cipherlogs.github.io/print/",
      visitId: "abc",
    }),
    PROD_ENV,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["https://cipherlogs.github.io/print/"]);
});

test("POST /click rejects lookalike github.io hosts before any fetch", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  for (const target of [
    "https://evil.github.io/print/",
    "https://cipherlogs.github.io.evil.test/",
  ]) {
    const response = await worker.fetch(
      clickRequest({ url: target, visitId: "abc" }),
      PROD_ENV,
    );
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { reason: string }).reason,
      "bad_target",
    );
  }

  assert.equal(fetches, 0);
});

test("POST /click maps a network failure to 502 fetch_failed", async () => {
  stubThrowingFetch(new Error("dial tcp: connection refused"));

  const response = await worker.fetch(clickRequest(), PROD_ENV);
  assert.equal(response.status, 502);

  const body = (await response.json()) as { ok: boolean; reason: string; detail: string };
  assert.equal(body.ok, false);
  assert.equal(body.reason, "fetch_failed");
  assert.match(body.detail, /connection refused/);
});

test("POST /click maps a timeout to 502 timeout", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  stubThrowingFetch(timeout);

  const response = await worker.fetch(clickRequest(), PROD_ENV);
  assert.equal(response.status, 502);
  assert.equal(((await response.json()) as { reason: string }).reason, "timeout");
});

test("other methods and paths are rejected", async () => {
  const wrongMethod = await worker.fetch(
    new Request("https://pool.example/click", { method: "GET" }),
    PROD_ENV,
  );
  assert.equal(wrongMethod.status, 405);

  const unknown = await worker.fetch(
    new Request("https://pool.example/nope", { method: "GET" }),
    PROD_ENV,
  );
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { reason: string }).reason, "not_found");
});
