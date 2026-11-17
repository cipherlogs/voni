/**
 * The header half of a simulated click. The request is fake — a function that
 * records its arguments — so the assertions are about exactly what the target
 * was told: a real browser's User-Agent, a Referer only when the webmail
 * provider has one, and no cookie or navigation state passed along.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { simulateOneClick, CLICK_SIMULATOR_MAX_HOPS, CLICK_SIMULATOR_TIMEOUT_MS } from "./click-simulator";
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
  assert.equal(request.init.redirect, "manual");
  assert.equal(request.init.cache, "no-store");
  // The drawn profile is Chrome desktop, so its client hints ride along.
  assert.match(request.init.headers["sec-ch-ua"], /Chrome";v="\d+"/);
  assert.equal(request.init.headers["sec-ch-ua-platform"], '"Windows"');

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

test("a non-2xx/3xx answer is reported as not ok but still measured", async () => {  const result = await simulateOneClick({
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

/** A fetch that answers each URL from a script, so a hop count is observable. */
function scriptedFetcher(
  routes: Record<string, { status: number; location?: string }>,
  seen: string[],
) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const spec = routes[url];
    // An unscripted URL means the simulator followed somewhere it should not
    // have; throwing keeps that a test failure rather than a silent extra hop.
    if (!spec) throw new Error(`unexpected request: ${url}`);
    return new Response(null, {
      status: spec.status,
      headers: spec.location === undefined ? {} : { location: spec.location },
    });
  }) as unknown as typeof fetch;
}

test("a 302 to another approved host is followed and its URL is the landing page", async () => {
  const landing = "https://www.glizzitrium.com/BCMPW39K/CZ562T2/";
  const seen: string[] = [];
  const result = await simulateOneClick({
    target: "https://voni.cc/test",
    source: null,
    random: () => 0,
    fetcher: scriptedFetcher(
      {
        "https://voni.cc/test": { status: 302, location: landing },
        [landing]: { status: 200 },
      },
      seen,
    ),
  });

  assert.deepEqual(seen, ["https://voni.cc/test", landing]);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, landing);
});

test("a 302 to the metadata address is refused and the rejected URL is not echoed", async () => {
  const seen: string[] = [];
  const result = await simulateOneClick({
    target: "https://voni.cc/test",
    source: null,
    random: () => 0,
    fetcher: scriptedFetcher(
      {
        "https://voni.cc/test": {
          status: 302,
          location: "http://169.254.169.254/latest/meta-data/iam/",
        },
      },
      seen,
    ),
  });

  // Only the approved URL was dialled: the refused hop never became a request.
  assert.deepEqual(seen, ["https://voni.cc/test"]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 302);
  assert.equal(result.finalUrl, "https://voni.cc/test");
  assert.match(result.message, /left the approved hosts/);
  assert.equal(result.message.includes("169.254"), false);
  assert.equal(result.message.includes("meta-data"), false);
});

test("a 302 to a file: URL is refused", async () => {
  const seen: string[] = [];
  const result = await simulateOneClick({
    target: "https://voni.cc/test",
    source: null,
    random: () => 0,
    fetcher: scriptedFetcher(
      {
        "https://voni.cc/test": { status: 302, location: "file:///etc/passwd" },
      },
      seen,
    ),
  });

  assert.deepEqual(seen, ["https://voni.cc/test"]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 302);
  assert.match(result.message, /left the approved hosts/);
  assert.equal(result.message.includes("passwd"), false);
});

test("a chain longer than ten hops is refused at the limit", async () => {
  const seen: string[] = [];
  const routes: Record<string, { status: number; location: string }> = {};
  const hopUrl = (hop: number) => `https://voni.cc/test?hop=${hop}`;
  for (let hop = 0; hop <= CLICK_SIMULATOR_MAX_HOPS; hop += 1) {
    routes[hopUrl(hop)] = { status: 302, location: hopUrl(hop + 1) };
  }

  const result = await simulateOneClick({
    target: hopUrl(0),
    source: null,
    random: () => 0,
    fetcher: scriptedFetcher(routes, seen),
  });

  // Ten hops were followed; the eleventh redirect was not.
  assert.equal(seen.length, CLICK_SIMULATOR_MAX_HOPS + 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, 302);
  assert.equal(result.finalUrl, hopUrl(CLICK_SIMULATOR_MAX_HOPS));
  assert.match(result.message, /exceeded 10 hops/);
});

test("a target outside the approved hosts is never fetched", async () => {
  const recorded: Recorded[] = [];
  const result = await simulateOneClick({
    target: "https://evil.example/landing",
    source: null,
    random: () => 0,
    fetcher: recordingFetcher(recorded),
  });

  assert.equal(recorded.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.message, /approved host/);
  assert.equal(result.message.includes("evil.example"), false);
});

test("a 3xx with no Location is a refusal, not a visit", async () => {
  for (const status of [301, 302, 307]) {
    const target = `https://voni.cc/no-destination-${status}`;
    const seen: string[] = [];
    const result = await simulateOneClick({
      target,
      source: null,
      random: () => 0,
      fetcher: scriptedFetcher({ [target]: { status } }, seen),
    });

    assert.equal(result.ok, false, `HTTP ${status} with no Location is not a visit`);
    assert.equal(result.status, status);
    assert.equal(
      result.finalUrl,
      target,
      "the last accepted URL is recorded, not a destination that never existed",
    );
    assert.match(result.message, /Redirected without a destination/);
  }
});

test("an approved host with a trailing dot is accepted, not called a foreign host", async () => {
  const target = "https://www.glizzitrium.com./BCMPW39K/CZ562T2/";
  const recorded: Recorded[] = [];
  const result = await simulateOneClick({
    target,
    source: null,
    random: () => 0,
    fetcher: recordingFetcher(recorded),
  });

  assert.deepEqual(
    recorded.map((entry) => entry.url),
    [target],
    "the legal root form of an approved host is dialled",
  );
  assert.equal(result.ok, true);
  assert.equal(result.finalUrl, target);
});

test("a host with two trailing dots is still refused", async () => {
  const recorded: Recorded[] = [];
  const result = await simulateOneClick({
    target: "https://www.glizzitrium.com../BCMPW39K/CZ562T2/",
    source: null,
    random: () => 0,
    fetcher: recordingFetcher(recorded),
  });

  assert.equal(recorded.length, 0);
  assert.equal(result.ok, false);
  assert.match(result.message, /approved host/);
});

test("a plaintext hop on an approved host is never fetched", async () => {
  const recorded: Recorded[] = [];
  const result = await simulateOneClick({
    target: "http://www.glizzitrium.com/BCMPW39K/CZ562T2/",
    source: null,
    random: () => 0,
    fetcher: recordingFetcher(recorded),
  });

  assert.equal(recorded.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.message, /approved host/);
});

test("a non-default port on an approved host is never fetched", async () => {
  const recorded: Recorded[] = [];
  const result = await simulateOneClick({
    target: "https://www.glizzitrium.com:8443/BCMPW39K/CZ562T2/",
    source: null,
    random: () => 0,
    fetcher: recordingFetcher(recorded),
  });

  assert.equal(recorded.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.message, /approved host/);
});

test("a redirect to a plaintext or extra-port URL is refused before it is dialled", async () => {
  for (const location of [
    "http://www.glizzitrium.com/BCMPW39K/CZ562T2/",
    "https://www.glizzitrium.com:8443/BCMPW39K/CZ562T2/",
  ]) {
    const seen: string[] = [];
    const result = await simulateOneClick({
      target: "https://voni.cc/test",
      source: null,
      random: () => 0,
      fetcher: scriptedFetcher(
        { "https://voni.cc/test": { status: 302, location } },
        seen,
      ),
    });

    assert.deepEqual(seen, ["https://voni.cc/test"], `${location} is not dialled`);
    assert.equal(result.ok, false);
    assert.equal(result.status, 302);
    assert.equal(result.finalUrl, "https://voni.cc/test");
    assert.match(result.message, /left the approved hosts/);
  }
});
