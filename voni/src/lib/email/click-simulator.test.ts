/**
 * The header half of a simulated click. The request is fake — a function that
 * records its arguments — so the assertions are about exactly what the target
 * was told: a real browser's User-Agent, a Referer only when the webmail
 * provider has one, and no cookie or navigation state passed along.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { simulateOneClick, CLICK_SIMULATOR_TIMEOUT_MS } from "./click-simulator";
import { BROWSER_PROFILES } from "./user-agents";

type Recorded = {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
};

/** A fetch that answers 200 and hands back what it was asked to send. */
function recordingFetcher(recorded: Recorded[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({
      url: String(input),
      init: init as Recorded["init"],
    });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

test("the click sends the chosen profile's User-Agent and the browser's accept headers", async () => {
  const recorded: Recorded[] = [];
  const result = await simulateOneClick({
    target: "https://voni.cc/landing?utm_source=gmail.com",
    source: "gmail.com",
    random: () => 0,
    fetcher: recordingFetcher(recorded),
    now: () => 1_000,
  });

  assert.equal(recorded.length, 1);
  const request = recorded[0]!;
  assert.equal(request.url, "https://voni.cc/landing?utm_source=gmail.com");
  assert.equal(request.init.headers["user-agent"], BROWSER_PROFILES[0]!.userAgent);
  assert.match(request.init.headers["accept"], /text\/html/);
  assert.equal(request.init.headers["accept-language"], "en-US,en;q=0.9");
  assert.equal(request.init.redirect, "follow");
  assert.equal(request.init.cache, "no-store");

  assert.equal(result.userAgent, BROWSER_PROFILES[0]!.userAgent);
  assert.equal(result.device, BROWSER_PROFILES[0]!.device);
  assert.equal(result.browser, BROWSER_PROFILES[0]!.browser);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.message.includes("gmail"), false);
});

test("a gmail visit carries the Gmail origin as Referer", async () => {
  const recorded: Recorded[] = [];
  await simulateOneClick({
    target: "https://voni.cc/landing",
    source: "gmail.com",
    random: () => 0,
    fetcher: recordingFetcher(recorded),
  });
  assert.equal(recorded[0]!.init.headers["referer"], "https://mail.google.com/");
});

test("an ISP mailbox sends no Referer header at all", async () => {
  const recorded: Recorded[] = [];
  await simulateOneClick({
    target: "https://voni.cc/landing",
    source: "verizon.com",
    random: () => 0,
    fetcher: recordingFetcher(recorded),
  });
  assert.equal("referer" in recorded[0]!.init.headers, false);
});

test("a missing source sends no Referer header", async () => {
  const recorded: Recorded[] = [];
  await simulateOneClick({
    target: "https://voni.cc/landing",
    source: null,
    random: () => 0,
    fetcher: recordingFetcher(recorded),
  });
  assert.equal("referer" in recorded[0]!.init.headers, false);
});

test("a non-2xx/3xx answer is reported as not ok but still measured", async () => {
  const result = await simulateOneClick({
    target: "https://voni.cc/landing",
    source: null,
    random: () => 0.999,
    fetcher: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
    now: (() => {
      let clock = 0;
      return () => (clock += 250);
    })(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.ms, 250);
  assert.equal(result.device, BROWSER_PROFILES[BROWSER_PROFILES.length - 1]!.device);
});

test("a transport failure is reported without echoing the target", async () => {
  const target = "https://voni.cc/landing?secret=abc";
  const result = await simulateOneClick({
    target,
    source: null,
    random: () => 0,
    fetcher: (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch,
    now: (() => {
      let clock = 0;
      return () => (clock += 100);
    })(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.finalUrl, null);
  assert.equal(result.ms, 100);
  assert.equal(result.message.includes("ECONNREFUSED"), false);
  assert.equal(result.message.includes(target), false);
});

test("a timeout is named as a timeout, not a generic failure", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const result = await simulateOneClick({
    target: "https://voni.cc/landing",
    source: null,
    random: () => 0,
    fetcher: (async () => {
      throw timeout;
    }) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(`${CLICK_SIMULATOR_TIMEOUT_MS / 1000} s`));
});
