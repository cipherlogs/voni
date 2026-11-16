import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildTargetHeaders,
  poolWorkerId,
  runClick,
  DEFAULT_USER_AGENT,
} from "../src/click.ts";

const ENV = {
  POOL_INDEX: "0",
  POOL_USER_AGENT: "pool-test-agent/1.0",
};

const TARGET = new URL("https://voni.cc/test?utm_source=gmail.com");

interface Call {
  input: string;
  init: RequestInit | undefined;
}

function recordingFetch(response: Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function throwingFetch(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

test("buildTargetHeaders matches the contract header set", () => {
  const headers = buildTargetHeaders("email-pool-01", ENV);

  assert.equal(headers["user-agent"], "pool-test-agent/1.0");
  assert.equal(headers.referer, "https://voni.cc/email");
  assert.equal(
    headers.accept,
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  );
  assert.equal(headers["accept-language"], "en-US,en;q=0.9");
  assert.equal(headers["x-pool-worker"], "email-pool-01");
});

test("buildTargetHeaders falls back to the Chrome desktop UA", () => {
  const headers = buildTargetHeaders("email-pool-02", {});
  assert.equal(headers["user-agent"], DEFAULT_USER_AGENT);
  assert.match(DEFAULT_USER_AGENT, /Chrome\/\d+/);
});

test("poolWorkerId derives the deploy name from POOL_INDEX", () => {
  assert.equal(poolWorkerId({ POOL_INDEX: "0" }), "email-pool-01");
  assert.equal(poolWorkerId({ POOL_INDEX: "2" }), "email-pool-03");
  assert.equal(poolWorkerId({}), "email-pool-01");
  assert.equal(poolWorkerId({ POOL_INDEX: "9", POOL_WORKER_ID: "manual-01" }), "manual-01");
});

test("runClick returns the 200 shape for a 200 response", async () => {
  const { calls, fetchImpl } = recordingFetch(new Response("ok", { status: 200 }));

  const result = await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA" });

  assert.equal(result.worker, "email-pool-01");
  assert.equal(result.colo, "FRA");
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.target, TARGET.toString());
  assert.equal(result.location, null);
  assert.equal(result.reason, null);
  assert.equal(typeof result.ms, "number");
  assert.ok(result.ms >= 0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, TARGET.toString());
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.redirect, "manual");
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

test("runClick sends the contract headers on the wire", async () => {
  const { calls, fetchImpl } = recordingFetch(new Response(null, { status: 200 }));

  await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA" });

  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("referer"), "https://voni.cc/email");
  assert.equal(headers.get("x-pool-worker"), "email-pool-01");
  assert.equal(headers.get("accept-language"), "en-US,en;q=0.9");
  assert.equal(headers.get("user-agent"), "pool-test-agent/1.0");
});

test("runClick reports a 302 with its location", async () => {
  const { fetchImpl } = recordingFetch(
    new Response(null, { status: 302, headers: { location: "https://voni.cc/demo" } }),
  );

  const result = await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA" });

  assert.equal(result.ok, true);
  assert.equal(result.status, 302);
  assert.equal(result.location, "https://voni.cc/demo");
  assert.equal(result.reason, null);
});

test("runClick maps a thrown fetch error to fetch_failed", async () => {
  const result = await runClick(TARGET, ENV, {
    fetch: throwingFetch(new Error("connection reset")),
    colo: "FRA",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.reason, "fetch_failed");
  assert.match(result.detail ?? "", /connection reset/);
});

test("runClick maps a timeout abort to timeout", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";

  const result = await runClick(TARGET, ENV, {
    fetch: throwingFetch(timeout),
    colo: "FRA",
    timeoutMs: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.status, null);
});

test("runClick reports a 500 as an observed http_error", async () => {
  const { fetchImpl } = recordingFetch(new Response(null, { status: 500 }));

  const result = await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA" });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.reason, "http_error");
});
