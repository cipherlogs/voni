import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { PinnedClick } from "../src/pinned-click.ts";
import { CLICK_TIMEOUT_MS } from "../src/click.ts";
import type { PoolEnv } from "../src/click.ts";

const realFetch = globalThis.fetch;

const ENV: PoolEnv = {
  POOL_INDEX: "0",
  POOL_USER_AGENT: "pool-test-agent/1.0",
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A response shaped the way a followed redirect chain ends. */
function landed(
  url: string,
  status = 200,
  redirected = true,
): Response {
  const response = new Response(null, { status });
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

/** A DO instance with no runtime; `state` is unused by the class today. */
function pinnedClick(env: PoolEnv = ENV): PinnedClick {
  return new PinnedClick({} as unknown as DurableObjectState, env);
}

/** The request the /click route sends: target + hint, no object state. */
function clickRequest(
  body: unknown = { url: "https://voni.cc/test", region: "enam" },
  colo?: string,
): Request {
  const request = new Request("https://pinned-click.internal/click", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  // The runtime attaches cf to a request a DO receives; simulate it so colo
  // reporting is exercised instead of assumed.
  if (colo !== undefined) {
    Object.defineProperty(request, "cf", { value: { colo }, configurable: true });
  }

  return request;
}

test("PinnedClick returns the observation with region and a null colo", async () => {
  stubFetch(() => landed("https://voni.cc/demo?ref=mail", 200, true));

  const response = await pinnedClick().fetch(clickRequest());

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
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
  assert.equal(body.worker, "email-pool-01");
  assert.equal(body.region, "enam");
  // no cf on this request: null, never a fabricated colo
  assert.equal(body.colo, null);
  assert.equal(body.ok, true);
  assert.equal(body.status, 200);
  assert.equal(body.target, "https://voni.cc/test");
  assert.equal(body.finalUrl, "https://voni.cc/demo?ref=mail");
  assert.equal(body.redirected, true);
  assert.equal(body.reason, null);
});

test("PinnedClick reports the colo the runtime delivered to the object", async () => {
  stubFetch(() => landed("https://voni.cc/test", 200, false));

  const response = await pinnedClick().fetch(clickRequest(undefined, "IAD"));

  const body = (await response.json()) as { colo: string | null; region: string };
  assert.equal(body.colo, "IAD");
  assert.equal(body.region, "enam");
});

test("PinnedClick reports region and colo on a transport failure too", async () => {
  stubThrowingFetch(new Error("dial tcp: connection refused"));

  const response = await pinnedClick().fetch(clickRequest(undefined, "ATL"));

  assert.equal(response.status, 502);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.status, null);
  assert.equal(body.region, "enam");
  assert.equal(body.colo, "ATL");
  assert.equal(body.reason, "fetch_failed");
  assert.equal("finalUrl" in body, false);
  assert.match(String(body.detail), /connection refused/);
});

test("PinnedClick keeps the contract's 8s click budget", async () => {
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return landed("https://voni.cc/test", 200, false);
  }) as typeof fetch;

  await pinnedClick().fetch(clickRequest());

  // The caller side is raised to 10s; the object's own budget is unchanged.
  assert.equal(CLICK_TIMEOUT_MS, 8_000);
  assert.ok(signal instanceof AbortSignal);
});

test("PinnedClick rejects an unknown region instead of echoing it", async () => {
  const seen = stubFetch(() => landed("https://voni.cc/test"));

  const response = await pinnedClick().fetch(
    clickRequest({ url: "https://voni.cc/test", region: "north" }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    reason: "bad_region",
    detail: "region must be one of the supported location hints",
  });
  assert.deepEqual(seen, []);
});

test("PinnedClick rejects a missing region", async () => {
  const response = await pinnedClick().fetch(
    clickRequest({ url: "https://voni.cc/test" }),
  );

  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { reason: string }).reason, "bad_region");
});

test("PinnedClick re-validates the target at its own boundary", async () => {
  const seen = stubFetch(() => landed("https://voni.cc/test"));

  const response = await pinnedClick().fetch(
    clickRequest({ url: "ftp://voni.cc/test", region: "enam" }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string; detail: string };
  assert.equal(body.reason, "bad_target");
  assert.match(body.detail, /use http or https/);
  assert.deepEqual(seen, []);
});

test("PinnedClick rejects a malformed body", async () => {
  const response = await pinnedClick().fetch(clickRequest("{not json"));

  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string; detail: string };
  assert.equal(body.reason, "bad_request");
  assert.match(body.detail, /not valid JSON/);
});

test("PinnedClick sends the pool headers from its own env", async () => {
  let headers = new Headers();
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return landed("https://voni.cc/test", 200, false);
  }) as typeof fetch;

  await pinnedClick({ POOL_INDEX: "4", POOL_USER_AGENT: "pinned-agent/2.0" }).fetch(
    clickRequest(),
  );

  assert.equal(headers.get("user-agent"), "pinned-agent/2.0");
  assert.equal(headers.get("x-pool-worker"), "email-pool-05");
  assert.equal(headers.get("referer"), "https://voni.cc/email");
});
