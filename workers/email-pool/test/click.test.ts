import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildTargetHeaders,
  poolWorkerId,
  runClick,
  DEFAULT_USER_AGENT,
} from "../src/click.ts";
import type { ClickObservation, ClickResult } from "../src/click.ts";

const ENV = {
  POOL_INDEX: "0",
  POOL_USER_AGENT: "pool-test-agent/1.0",
};

const TARGET = new URL("https://voni.cc/test?utm_source=gmail.com");

interface Call {
  input: string;
  init: RequestInit | undefined;
}

/** A response shaped the way a followed redirect chain ends. */
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

/** Narrow to the observed-response shape; a transport failure here is a bug. */
function observed(result: ClickResult): ClickObservation {
  if (result.status === null) {
    assert.fail(`expected an observed response, got ${result.reason}`);
  }
  return result;
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

test("runClick follows redirects and reports the landing response", async () => {
  const { calls, fetchImpl } = recordingFetch(
    landed(TARGET.toString(), 200, false),
  );

  const result = observed(await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA", region: "enam" }));

  assert.equal(result.worker, "email-pool-01");
  assert.equal(result.colo, "FRA");
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.target, TARGET.toString());
  assert.equal(result.finalUrl, TARGET.toString());
  assert.equal(result.redirected, false);
  assert.equal(result.reason, null);
  assert.equal(typeof result.ms, "number");
  assert.ok(result.ms >= 0);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, TARGET.toString());
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.redirect, "follow");
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

test("runClick sends the contract headers on the wire", async () => {
  const { calls, fetchImpl } = recordingFetch(landed("https://voni.cc/test"));

  await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA", region: "enam" });

  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("referer"), "https://voni.cc/email");
  assert.equal(headers.get("x-pool-worker"), "email-pool-01");
  assert.equal(headers.get("accept-language"), "en-US,en;q=0.9");
  assert.equal(headers.get("user-agent"), "pool-test-agent/1.0");
});

test("runClick reports the final status and finalUrl of a followed 302", async () => {
  const { fetchImpl } = recordingFetch(landed("https://voni.cc/demo?ref=mail", 200, true));

  const result = observed(await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA", region: "enam" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, "https://voni.cc/demo?ref=mail");
  assert.equal(result.redirected, true);
  assert.equal(result.reason, null);
  // hop-one's redirect header is gone: only the landing shape remains
  assert.deepEqual(Object.keys(result).sort(), [
    "colo",
    "finalUrl",
    "ms",
    "ok",
    "reason",
    "redirected",
    "region",
    "status",
    "target",
    "worker",
  ]);
});

test("runClick falls back to the requested target when response.url is empty", async () => {
  const { fetchImpl } = recordingFetch(new Response(null, { status: 204 }));

  const result = observed(await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA", region: "enam" }));

  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
  assert.equal(result.finalUrl, TARGET.toString());
  assert.equal(result.redirected, false);
});

test("runClick cancels the landed body instead of reading it", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull() {},
    cancel() {
      cancelled = true;
    },
  });
  const { fetchImpl } = recordingFetch(new Response(stream, { status: 200 }));

  await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA", region: "enam" });

  assert.equal(cancelled, true);
});

test("runClick maps a thrown fetch error to fetch_failed", async () => {
  const result = await runClick(TARGET, ENV, {
    fetch: throwingFetch(new Error("connection reset")),
    colo: "FRA",
    region: "enam",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.reason, "fetch_failed");
  // a failure still says where the click was pinned
  assert.equal(result.region, "enam");
  assert.equal(result.colo, "FRA");
  assert.equal("finalUrl" in result, false);
  assert.match(result.detail ?? "", /connection reset/);
});

test("runClick maps a timeout abort to timeout", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";

  const result = await runClick(TARGET, ENV, {
    fetch: throwingFetch(timeout),
    colo: "FRA",
    region: "enam",
    timeoutMs: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.status, null);
  assert.equal(result.region, "enam");
  assert.equal("finalUrl" in result, false);
});

test("runClick reports a null colo when the runtime supplied none", async () => {
  const { fetchImpl } = recordingFetch(landed(TARGET.toString(), 200, false));

  const result = observed(
    await runClick(TARGET, ENV, { fetch: fetchImpl, region: "unknown" }),
  );

  assert.equal(result.colo, null);
  assert.equal(result.region, "unknown");
});

test("runClick reports a 404 at the end of a chain as http_error", async () => {
  const { fetchImpl } = recordingFetch(landed("https://voni.cc/missing", 404, true));

  const result = observed(await runClick(TARGET, ENV, { fetch: fetchImpl, colo: "FRA", region: "enam" }));

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.finalUrl, "https://voni.cc/missing");
  assert.equal(result.redirected, true);
  assert.equal(result.reason, "http_error");
});
