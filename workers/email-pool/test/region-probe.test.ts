import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EGRESS_URL,
  TRACE_URL,
  isRegionHint,
  parseEgress,
  parseTrace,
  probeRegion,
} from "../src/region-probe.ts";
import type { RegionProbeResult } from "../src/region-probe.ts";

const TRACE_BODY = [
  "fl=20f123",
  "h=www.cloudflare.com",
  "ip=203.0.113.7",
  "ts=1763412345.123",
  "visit_scheme=https",
  "uag=node",
  "colo=IAD",
  "sliver=none",
  "http=http/2",
  "loc=US",
  "tls=TLSv1.3",
  "sni=plaintext",
  "warp=off",
  "gateway=off",
  "",
].join("\n");

const EGRESS_BODY = JSON.stringify({
  ip: "198.51.100.24",
  hostname: "no-host",
  city: "Ashburn",
  region: "Virginia",
  country: "US",
  loc: "39.0437,-77.4875",
  org: "AS14618 Amazon.com, Inc.",
  postal: "20149",
  timezone: "America/New_York",
  readme: "https://ipinfo.io/missingauth",
});

interface Call {
  input: string;
  init: RequestInit | undefined;
}

/**
 * Fake fetch keyed by URL. A value of `Error` throws, a function is called for
 * each request so a test can count calls.
 */
function routedFetch(
  routes: Record<string, Response | Error>,
): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ input: url, init });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (route instanceof Error) throw route;
    return route;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

function general(result: RegionProbeResult) {
  return { ok: result.ok, trace: result.trace, egress: result.egress };
}

test("parseTrace reads colo and ip out of the key=value lines", () => {
  assert.deepEqual(parseTrace(TRACE_BODY), { colo: "IAD", ip: "203.0.113.7" });
});

test("parseTrace ignores junk lines and keeps a value containing =", () => {
  const trace = parseTrace("noise\n=orphan\ncolo=FRA\nip=1.2.3.4\nx=a=b\n");
  assert.deepEqual(trace, { colo: "FRA", ip: "1.2.3.4" });
});

test("parseTrace without a colo has no usable observation", () => {
  assert.equal(parseTrace("ip=1.2.3.4\nloc=US\n"), null);
  assert.equal(parseTrace(""), null);
});

test("parseEgress takes the ip and its geography from ipinfo", () => {
  assert.deepEqual(parseEgress(EGRESS_BODY), {
    ip: "198.51.100.24",
    city: "Ashburn",
    region: "Virginia",
    country: "US",
    org: "AS14618 Amazon.com, Inc.",
  });
});

test("parseEgress rejects non-JSON and JSON without an ip", () => {
  assert.equal(parseEgress("<html>rate limited</html>"), null);
  assert.equal(parseEgress('{"error":{"title":"Rate limit exceeded"}}'), null);
});

test("probeRegion reports the trace colo and the egress geography", async () => {
  const { calls, fetchImpl } = routedFetch({
    [TRACE_URL]: new Response(TRACE_BODY, { status: 200 }),
    [EGRESS_URL]: new Response(EGRESS_BODY, { status: 200 }),
  });

  const result = await probeRegion({ fetch: fetchImpl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.trace, { colo: "IAD", ip: "203.0.113.7" });
  assert.deepEqual(result.egress, {
    ip: "198.51.100.24",
    city: "Ashburn",
    region: "Virginia",
    country: "US",
    org: "AS14618 Amazon.com, Inc.",
  });
  assert.deepEqual(result.errors, {});
  assert.equal(typeof result.ms, "number");
  assert.ok(result.ms >= 0);

  assert.deepEqual(
    calls.map((call) => call.input).sort(),
    [TRACE_URL, EGRESS_URL].sort(),
  );
  for (const call of calls) {
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.redirect, "follow");
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});

test("probeRegion degrades to egress only when the trace fetch fails", async () => {
  const { fetchImpl } = routedFetch({
    [TRACE_URL]: new Error("dial tcp: connection refused"),
    [EGRESS_URL]: new Response(EGRESS_BODY, { status: 200 }),
  });

  const result = await probeRegion({ fetch: fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.trace, null);
  assert.equal(result.egress?.country, "US");
  assert.equal(result.errors.trace, "fetch_failed");
  assert.equal(result.errors.egress, undefined);
});

test("probeRegion degrades to trace only when ipinfo answers an error status", async () => {
  const { fetchImpl } = routedFetch({
    [TRACE_URL]: new Response(TRACE_BODY, { status: 200 }),
    [EGRESS_URL]: new Response("nope", { status: 429 }),
  });

  const result = await probeRegion({ fetch: fetchImpl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.trace, { colo: "IAD", ip: "203.0.113.7" });
  assert.equal(result.egress, null);
  assert.equal(result.errors.egress, "http_429");
});

test("probeRegion cancels the body of a source it refuses to read", async () => {
  let traceCancelled = false;
  const traceBody = new ReadableStream({
    pull() {},
    cancel() {
      traceCancelled = true;
    },
  });

  const { fetchImpl } = routedFetch({
    [TRACE_URL]: new Response(traceBody, { status: 500 }),
    [EGRESS_URL]: new Response(EGRESS_BODY, { status: 200 }),
  });

  const result = await probeRegion({ fetch: fetchImpl });

  assert.equal(result.errors.trace, "http_500");
  assert.equal(traceCancelled, true);
  assert.equal(result.ok, true);
});

test("probeRegion reports an unparseable trace body as parse_failed", async () => {
  const { fetchImpl } = routedFetch({
    [TRACE_URL]: new Response("<html>blocked</html>", { status: 200 }),
    [EGRESS_URL]: new Response(EGRESS_BODY, { status: 200 }),
  });

  const result = await probeRegion({ fetch: fetchImpl });

  assert.equal(result.trace, null);
  assert.equal(result.errors.trace, "parse_failed");
  assert.equal(result.ok, true);
});

test("probeRegion reports a total failure as ok:false with both sources named", async () => {
  const { fetchImpl } = routedFetch({
    [TRACE_URL]: new Error("getaddrinfo ENOTFOUND"),
    [EGRESS_URL]: new Response("<html>blocked</html>", { status: 200 }),
  });

  const result = await probeRegion({ fetch: fetchImpl });

  assert.deepEqual(general(result), { ok: false, trace: null, egress: null });
  assert.deepEqual(result.errors, {
    trace: "fetch_failed",
    egress: "parse_failed",
  });
});

test("probeRegion reports a timeout as a named error instead of throwing", async () => {
  const { fetchImpl } = routedFetch({ [TRACE_URL]: timeoutError() });

  const settled = await probeRegion({ fetch: fetchImpl, timeoutMs: 5 });

  assert.equal(settled.errors.trace, "timeout");
  // the egress route was never stubbed: its own throw is a named error too
  assert.equal(settled.errors.egress, "fetch_failed");
  assert.equal(settled.ok, false);
});

test("probeRegion treats a non-abort rejection as fetch_failed", async () => {
  const { fetchImpl } = routedFetch({
    [TRACE_URL]: new TypeError("fetch failed"),
    [EGRESS_URL]: new TypeError("fetch failed"),
  });

  const result = await probeRegion({ fetch: fetchImpl });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, {
    trace: "fetch_failed",
    egress: "fetch_failed",
  });
});

test("isRegionHint accepts exactly the supported hints", () => {
  for (const hint of ["wnam", "enam", "sam", "apac", "weur", "eeur", "oc", "afr", "me"]) {
    assert.equal(isRegionHint(hint), true, hint);
  }
  for (const bad of ["us", "ENAM", "", "iata", "apac-ne"]) {
    assert.equal(isRegionHint(bad), false, bad);
  }
});
