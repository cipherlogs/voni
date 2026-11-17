import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.ts";

const SECRET = "pool-secret-abc123";
const realFetch = globalThis.fetch;

const ENV = {
  POOL_SECRET: SECRET,
  POOL_INDEX: "0",
  POOL_USER_AGENT: "pool-test-agent/1.0",
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A response shaped the way a followed redirect chain ends: final url set. */
function landed(
  url: string,
  status = 200,
  redirected = true,
  body: string | null = null,
): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url, configurable: true });
  Object.defineProperty(response, "redirected", {
    value: redirected,
    configurable: true,
  });
  return response;
}

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

test("GET /health is public and reports the fetch contract", async () => {
  const response = await worker.fetch(healthRequest(), ENV);
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    worker: "email-pool-01",
    colo: "UNKNOWN",
    redirects: "follow",
    targets: "any absolute http(s) URL",
  });
});

test("POST /click without the secret is 401 unauthorized", async () => {
  const response = await worker.fetch(clickRequest(undefined, {}), ENV);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
});

test("POST /click with a wrong secret is 401 unauthorized", async () => {
  const response = await worker.fetch(
    clickRequest(undefined, { "x-pool-secret": "nope" }),
    ENV,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
});

test("POST /click accepts any host, not just voni's", async () => {
  const seen = stubFetch(() => landed("https://blog.example.org/post", 200, true));

  const response = await worker.fetch(
    clickRequest({ url: "https://blog.example.org/post", visitId: "abc" }),
    ENV,
  );
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.target, "https://blog.example.org/post");
  assert.deepEqual(seen, ["https://blog.example.org/post"]);
});

test("POST /click accepts a plain http target", async () => {
  const seen = stubFetch(() => landed("http://localhost:3000/email", 200, false));

  const response = await worker.fetch(
    clickRequest({ url: "http://localhost:3000/email", visitId: "abc" }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["http://localhost:3000/email"]);
});

test("POST /click rejects a non-URL with 400 bad_target", async () => {
  const response = await worker.fetch(
    clickRequest({ url: "not a url", visitId: "abc" }),
    ENV,
  );
  assert.equal(response.status, 400);

  const body = (await response.json()) as {
    ok: boolean;
    reason: string;
    detail: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.reason, "bad_target");
  assert.match(body.detail, /absolute http or https URL/);
});

test("POST /click rejects a non-http(s) protocol with 400 bad_target", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return landed("https://voni.cc/test");
  }) as typeof fetch;

  for (const target of ["ftp://voni.cc/test", "javascript:alert(1)"]) {
    const response = await worker.fetch(
      clickRequest({ url: target, visitId: "abc" }),
      ENV,
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { reason: string; detail: string };
    assert.equal(body.reason, "bad_target");
    assert.match(body.detail, /use http or https/);
  }

  assert.equal(fetches, 0);
});

test("POST /click rejects a malformed JSON body", async () => {
  const response = await worker.fetch(clickRequest("{not json"), ENV);
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { reason: string }).reason, "bad_request");
});

test("POST /click returns exactly the 200 shape on success", async () => {
  stubFetch(() => landed("https://voni.cc/test", 200, false, "ok"));

  const response = await worker.fetch(clickRequest(), ENV);
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "colo",
    "finalUrl",
    "ms",
    "ok",
    "reason",
    "redirected",
    "status",
    "target",
    "worker",
  ]);
  assert.equal(body.worker, "email-pool-01");
  assert.equal(body.colo, "UNKNOWN");
  assert.equal(body.ok, true);
  assert.equal(body.status, 200);
  assert.equal(body.finalUrl, "https://voni.cc/test");
  assert.equal(body.redirected, false);
  assert.equal(body.reason, null);
  assert.equal(body.target, "https://voni.cc/test");
  assert.equal(typeof body.ms, "number");
});

test("POST /click reports the landing page of a followed 302", async () => {
  stubFetch(() => landed("https://voni.cc/demo?ref=mail", 200, true));

  const response = await worker.fetch(
    clickRequest({ url: "https://voni.cc/test", visitId: "abc" }),
    ENV,
  );
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    ok: boolean;
    status: number;
    finalUrl: string;
    redirected: boolean;
    target: string;
    reason: string | null;
  };
  assert.equal(body.ok, true);
  assert.equal(body.status, 200);
  assert.equal(body.finalUrl, "https://voni.cc/demo?ref=mail");
  assert.equal(body.redirected, true);
  assert.equal(body.target, "https://voni.cc/test");
  assert.equal(body.reason, null);
});

test("POST /click reports a 404 at the end of a chain as http_error", async () => {
  stubFetch(() => landed("https://voni.cc/missing", 404, true));

  const response = await worker.fetch(clickRequest(), ENV);
  // the target answered: this is an observation, not a pool failure
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    ok: boolean;
    status: number;
    finalUrl: string;
    redirected: boolean;
    reason: string | null;
  };
  assert.equal(body.ok, false);
  assert.equal(body.status, 404);
  assert.equal(body.finalUrl, "https://voni.cc/missing");
  assert.equal(body.redirected, true);
  assert.equal(body.reason, "http_error");
});

test("POST /click falls back to the requested target when response.url is empty", async () => {
  stubFetch(() => new Response(null, { status: 200 }));

  const body = (await (
    await worker.fetch(clickRequest(), ENV)
  ).json()) as { finalUrl: string; redirected: boolean };
  assert.equal(body.finalUrl, "https://voni.cc/test");
  assert.equal(body.redirected, false);
});

test("POST /click maps a network failure to 502 fetch_failed with no finalUrl", async () => {
  stubThrowingFetch(new Error("dial tcp: connection refused"));

  const response = await worker.fetch(clickRequest(), ENV);
  assert.equal(response.status, 502);

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.reason, "fetch_failed");
  assert.equal("finalUrl" in body, false);
  assert.equal("redirected" in body, false);
  assert.match(String(body.detail), /connection refused/);
});

test("POST /click maps a timeout to 502 timeout", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  stubThrowingFetch(timeout);

  const response = await worker.fetch(clickRequest(), ENV);
  assert.equal(response.status, 502);

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.reason, "timeout");
  assert.equal("finalUrl" in body, false);
});

test("other methods and paths are rejected", async () => {
  const wrongMethod = await worker.fetch(
    new Request("https://pool.example/click", { method: "GET" }),
    ENV,
  );
  assert.equal(wrongMethod.status, 405);

  const unknown = await worker.fetch(
    new Request("https://pool.example/nope", { method: "GET" }),
    ENV,
  );
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { reason: string }).reason, "not_found");
});

// --- GET /probe-region -----------------------------------------------------

const PROBE_RESULT = {
  ok: true,
  trace: { colo: "IAD", ip: "203.0.113.7" },
  egress: {
    ip: "198.51.100.24",
    city: "Ashburn",
    region: "Virginia",
    country: "US",
    org: "AS14618 Amazon.com, Inc.",
  },
  ms: 412,
  errors: {},
};

interface ProbeCalls {
  ids: string[];
  options: unknown[];
  fetches: string[];
}

/** A Durable Object namespace stand-in; records the id and location hint used. */
function stubRegion(body: unknown, status = 200): {
  namespace: DurableObjectNamespace;
  calls: ProbeCalls;
} {
  const calls: ProbeCalls = { ids: [], options: [], fetches: [] };

  const namespace = {
    idFromName(name: string) {
      calls.ids.push(name);
      return { toString: () => name, name };
    },
    get(_id: unknown, options?: unknown) {
      calls.options.push(options);
      return {
        async fetch(request: Request): Promise<Response> {
          calls.fetches.push(request.url);
          return new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  } as unknown as DurableObjectNamespace;

  return { namespace, calls };
}

function probeRequest(
  query = "",
  headers: Record<string, string> = { "x-pool-secret": SECRET },
  method = "GET",
): Request {
  return new Request(`https://pool.example/probe-region${query}`, {
    method,
    headers,
  });
}

function probeEnv(namespace?: DurableObjectNamespace) {
  return namespace === undefined ? ENV : { ...ENV, POOL_REGION: namespace };
}

test("GET /probe-region without the secret is 401 unauthorized", async () => {
  const { namespace, calls } = stubRegion(PROBE_RESULT);

  const response = await worker.fetch(probeRequest("", {}), probeEnv(namespace));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
  assert.equal(calls.fetches.length, 0);
});

test("GET /probe-region with a wrong secret is 401 unauthorized", async () => {
  const { namespace } = stubRegion(PROBE_RESULT);

  const response = await worker.fetch(
    probeRequest("", { "x-pool-secret": "nope" }),
    probeEnv(namespace),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
});

test("GET /probe-region rejects an unknown hint with 400 bad_hint", async () => {
  const { namespace, calls } = stubRegion(PROBE_RESULT);

  const response = await worker.fetch(
    probeRequest("?hint=moon"),
    probeEnv(namespace),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, reason: "bad_hint" });
  assert.equal(calls.fetches.length, 0);
});

test("GET /probe-region is 503 probe_not_configured without the binding", async () => {
  const response = await worker.fetch(probeRequest("?hint=enam"), ENV);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    reason: "probe_not_configured",
  });
});

test("GET /probe-region defaults to enam on a per-hint object id", async () => {
  const { namespace, calls } = stubRegion(PROBE_RESULT);

  const response = await worker.fetch(probeRequest(), probeEnv(namespace));

  assert.equal(response.status, 200);
  assert.deepEqual(calls.ids, ["region-probe-enam"]);
  assert.deepEqual(calls.options, [{ locationHint: "enam" }]);
  assert.equal(calls.fetches.length, 1);
});

test("GET /probe-region passes the DO result through under a per-worker envelope", async () => {
  const { namespace } = stubRegion(PROBE_RESULT);

  const response = await worker.fetch(
    probeRequest("?hint=enam"),
    probeEnv(namespace),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "colo",
    "durableObject",
    "hint",
    "worker",
  ]);
  assert.equal(body.worker, "email-pool-01");
  assert.equal(body.colo, "UNKNOWN");
  assert.equal(body.hint, "enam");
  assert.deepEqual(body.durableObject, PROBE_RESULT);
});

test("GET /probe-region uses a distinct object id and hint per hint", async () => {
  const { namespace, calls } = stubRegion(PROBE_RESULT);

  await worker.fetch(probeRequest("?hint=weur"), probeEnv(namespace));
  await worker.fetch(probeRequest("?hint=apac"), probeEnv(namespace));

  assert.deepEqual(calls.ids, ["region-probe-weur", "region-probe-apac"]);
  assert.deepEqual(calls.options, [
    { locationHint: "weur" },
    { locationHint: "apac" },
  ]);
});

test("GET /probe-region mirrors a total DO failure as 502 with the result attached", async () => {
  const failed = {
    ok: false,
    trace: null,
    egress: null,
    ms: 5001,
    errors: { trace: "timeout", egress: "timeout" },
    reason: "both_sources_failed",
  };
  const { namespace } = stubRegion(failed, 502);

  const response = await worker.fetch(
    probeRequest("?hint=enam"),
    probeEnv(namespace),
  );

  assert.equal(response.status, 502);
  const body = (await response.json()) as {
    hint: string;
    durableObject: { ok: boolean; reason: string };
  };
  assert.equal(body.hint, "enam");
  assert.equal(body.durableObject.ok, false);
  assert.equal(body.durableObject.reason, "both_sources_failed");
});

test("GET /probe-region maps a throwing stub to 502 probe_unavailable", async () => {
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: () => ({
      async fetch(): Promise<Response> {
        throw new Error("object not found in this namespace");
      },
    }),
  } as unknown as DurableObjectNamespace;

  const response = await worker.fetch(
    probeRequest("?hint=enam"),
    probeEnv(namespace),
  );

  assert.equal(response.status, 502);
  const body = (await response.json()) as { reason: string; detail: string };
  assert.equal(body.reason, "probe_unavailable");
  assert.match(body.detail, /object not found/);
});

test("POST /probe-region is 405 method_not_allowed", async () => {
  const { namespace } = stubRegion(PROBE_RESULT);

  const response = await worker.fetch(
    probeRequest("?hint=enam", { "x-pool-secret": SECRET }, "POST"),
    probeEnv(namespace),
  );

  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { ok: false, reason: "method_not_allowed" });
});
