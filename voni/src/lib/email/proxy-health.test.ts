/**
 * Reading the client's health from the console.
 *
 * The card is only worth trusting if its read is honest in the three states the
 * client can be in: configured and answering, configured and silent, and never
 * configured at all. The read is a plain `GET /health` — the one endpoint the
 * control API documents as read-only — so it can never spend a change or move
 * an exit. The tests below use an injected fetcher for the failure states and
 * the client's real health server for the success state: the JSON the card
 * parses is the JSON the client actually writes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildHealth, startHealthServer } from "@/lib/tuxler/health";
import {
  PROXY_HEALTH_URL_ENV,
  parseHealthReport,
  readProxyHealth,
} from "./proxy-health";

type Call = { url: string; init: RequestInit | undefined };

function stubFetch(
  answer: Response | Error,
): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const VALID = {
  ok: true,
  ready: true,
  pool: [
    { exitId: "198.51.100.10:40001", ip: "198.51.100.10", country: "US", asn: "7018", city: "Austin", state: "TX" },
  ],
  buckets: [
    {
      clientIpHash: "abcdef",
      depth: 0,
      parentId: null,
      used: 2,
      limit: 10,
      remaining: 8,
      resetAt: "2026-11-26T00:00:00.000Z",
    },
  ],
  reconnects: 1,
  lastError: null,
  account: { tier: "free", premium: false, clientIp: "203.0.113.9" },
  session: { state: "connected" },
};

test("an unset address is 'client-down', and nothing is fetched", async () => {
  const { fetcher, calls } = stubFetch(new Response("{}"));
  const read = await readProxyHealth({ readEnv: async () => undefined, fetcher });
  assert.deepEqual(read, { state: "unconfigured" });
  assert.equal(calls.length, 0, "an absent client is not a request to nowhere");
  assert.equal(PROXY_HEALTH_URL_ENV, "TUXLER_CONTROL_URL");
});

test("an address that is not http(s) is refused without a request", async () => {
  const { fetcher, calls } = stubFetch(new Response("{}"));
  for (const bad of ["file:///etc/passwd", "ftp://example.test", "not a url", "javascript:alert(1)"]) {
    const read = await readProxyHealth({ readEnv: async () => bad, fetcher });
    assert.equal(read.state, "unreachable", `${bad} is not a client`);
  }
  assert.equal(calls.length, 0);
});

test("a client that is down is unreachable, not an exception", async () => {
  const refused = stubFetch(new Error("connect ECONNREFUSED 127.0.0.1:41000"));
  const read = await readProxyHealth({
    readEnv: async () => "http://127.0.0.1:41000",
    fetcher: refused.fetcher,
  });
  assert.equal(read.state, "unreachable");
  assert.match(read.state === "unreachable" ? read.message : "", /could not be reached|not answer/i);

  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  const slow = stubFetch(timeout);
  const timedOut = await readProxyHealth({
    readEnv: async () => "http://127.0.0.1:41000",
    fetcher: slow.fetcher,
  });
  assert.equal(timedOut.state, "unreachable");
  assert.match(timedOut.state === "unreachable" ? timedOut.message : "", /did not answer/i);
});

test("an error response or a body that is not a health report is unreachable", async () => {
  const answers = [
    () => new Response("upstream down", { status: 502 }),
    () => new Response("<html>login</html>", { status: 200 }),
    () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    () =>
      new Response(JSON.stringify({ session: { state: "connected" }, pool: "nope" }), {
        status: 200,
      }),
  ];
  for (const [index, answer] of answers.entries()) {
    const { fetcher } = stubFetch(answer());
    const read = await readProxyHealth({
      readEnv: async () => "http://127.0.0.1:41000",
      fetcher,
    });
    assert.equal(read.state, "unreachable", `answer ${index + 1} is not a pool`);
  }
});

test("the read is one GET of /health: no acquire, no release, no mutation", async () => {
  const { fetcher, calls } = stubFetch(
    new Response(JSON.stringify(VALID), { status: 200 }),
  );
  const read = await readProxyHealth({
    readEnv: async () => "http://127.0.0.1:41000/",
    fetcher,
  });
  assert.equal(read.state, "reported");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://127.0.0.1:41000/health");
  assert.equal(calls[0]!.init?.method ?? "GET", "GET");
  assert.equal(calls[0]!.init?.cache, "no-store");
  assert.doesNotMatch(calls[0]!.url, /acquire|release|pool|rotate/);
  assert.equal(calls[0]!.init?.body, undefined, "a read has no body");
});

test("a health report is parsed into what the card renders", async () => {
  const { fetcher } = stubFetch(new Response(JSON.stringify(VALID), { status: 200 }));
  const read = await readProxyHealth({
    readEnv: async () => "http://127.0.0.1:41000",
    fetcher,
  });
  assert.equal(read.state, "reported");
  if (read.state !== "reported") return;
  assert.equal(read.health.pool[0]!.ip, "198.51.100.10");
  assert.equal(read.health.pool[0]!.city, "Austin");
  assert.equal(read.health.buckets[0]!.remaining, 8);
  assert.equal(read.health.buckets[0]!.depth, 0);
  assert.equal(read.health.session.state, "connected");
  assert.equal(read.health.account?.tier, "free");
});

test("a malformed exit is dropped rather than taking the report down", () => {
  const parsed = parseHealthReport({
    ...VALID,
    pool: [
      ...VALID.pool,
      { ip: 123, country: "US" },
      { ip: "", country: "US" },
      null,
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.pool.length, 1, "only the well-formed exit survives");
});

test("the real client's health JSON is what the console reads", async () => {
  // The same server the runner starts, on loopback with no credential in it.
  const server = await startHealthServer({
    port: 0,
    snapshot: () =>
      buildHealth({
        state: "connected",
        snapshot: {
          state: "connected",
          host: "server3.ipsharkk.com",
          handshakeMs: 812,
          heartbeatSeconds: 50,
          clientIp: "203.0.113.9",
          silentForMs: 12,
          frames: ["CONNECT_LIST", "YOUR_IP"],
          account: {
            tier: "free",
            premium: false,
            changesUsed: 4,
            changesLimit: 7,
            bandwidthLimit: -1,
            poolLimit: null,
            resetAt: "2026-11-26T13:26:00.000Z",
          },
          failure: null,
        },
        bucketId: "abc",
        lastError: null,
        pool: {
          ready: 1,
          exits: [
            { exitId: "198.51.100.10:40001", ip: "198.51.100.10", country: "US", asn: "7018", city: "Austin", state: "TX" },
          ],
          buckets: [
            { clientIpHash: "abc", used: 4, limit: 7, remaining: 3, resetAt: "2026-11-26T13:26:00.000Z" },
          ],
          reconnects: 0,
          refills: 6,
          lastReconnect: null,
        },
      }),
  });
  try {
    const read = await readProxyHealth({ readEnv: async () => server.url });
    assert.equal(read.state, "reported");
    if (read.state !== "reported") return;
    assert.equal(read.health.pool[0]!.city, "Austin");
    assert.equal(read.health.buckets[0]!.remaining, 3);
  } finally {
    await server.close();
  }
});
