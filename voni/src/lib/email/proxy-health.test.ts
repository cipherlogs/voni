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
  NO_POOL_REPORT_MESSAGE,
  PROXY_HEALTH_URL_ENV,
  healthFromPoolReport,
  parseHealthReport,
  readProxyHealth,
  readProxyHealthOrReport,
} from "./proxy-health";
import { isProxyReportStale, proxyReportAge } from "./proxy-policy";
import type {
  LatestPoolReport,
  PoolReportStore,
  TuxlerPoolReport,
} from "./pool-report";

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

const REPORT_EXITS = [
  { exitId: "e1", ip: "198.51.100.24", country: "US", asn: "7018", city: "Ashburn", state: "VA" },
  { exitId: "e2", ip: "198.51.100.25", country: "US", asn: "7922", city: "Austin", state: "TX" },
  { exitId: "e3", ip: "198.51.100.26", country: "US", asn: "22773", city: "Phoenix", state: "AZ" },
];

/** `buildPoolReport` followed by `mergeFinalReport`, as the runner writes it. */
function storedReport(overrides: Partial<TuxlerPoolReport> = {}): TuxlerPoolReport {
  return {
    enabled: true,
    minReady: 3,
    gate: {
      ok: true,
      reason: null,
      detail: null,
      attempts: 2,
      waitedMs: 4_000,
      checkedAt: "2026-11-26T08:00:00.000Z",
      ready: 3,
      exits: REPORT_EXITS,
      refills: 1,
      reconnects: 0,
      lastError: null,
      clientLog: null,
    },
    final: {
      ok: true,
      error: null,
      checkedAt: "2026-11-26T09:00:00.000Z",
      ready: 3,
      exits: REPORT_EXITS,
      refills: 2,
      reconnects: 1,
      lastError: null,
    },
    ...overrides,
  };
}

function storeOf(
  latest: LatestPoolReport | null,
): { store: PoolReportStore; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    store: {
      async upsert() {},
      async latest() {
        calls.push(1);
        return latest;
      },
    },
  };
}

const NOW = new Date("2026-11-26T09:02:00.000Z");

test("a stored report renders the pool and names its age", async () => {
  const latest: LatestPoolReport = {
    runnerOs: "ubuntu",
    receivedAt: new Date("2026-11-26T09:00:00.000Z"),
    report: storedReport(),
  };
  const { store } = storeOf(latest);
  const { fetcher, calls } = stubFetch(new Error("should not be fetched"));

  const read = await readProxyHealthOrReport({
    readEnv: async () => undefined,
    fetcher,
    store,
  });

  assert.equal(calls.length, 0, "an unset address is not a request to nowhere");
  assert.equal(read.state, "reported");
  if (read.state !== "reported") return;
  assert.equal(read.source, "report");
  assert.equal(read.runnerOs, "ubuntu");
  assert.equal(read.receivedAt.toISOString(), "2026-11-26T09:00:00.000Z");
  assert.equal(read.health.pool.length, 3);
  assert.equal(read.health.pool[0]!.ip, "198.51.100.24");
  assert.equal(read.health.pool[0]!.asn, "7018");
  assert.deepEqual(read.health.buckets, [], "the artifact has no bucket snapshot");
  assert.equal(read.health.refills, 2);
  assert.equal(read.health.reconnects, 1);
  assert.equal(read.health.session.state, "connected");
  assert.equal(proxyReportAge(read.receivedAt, NOW), "2 minutes ago");
});

test("a live client wins over a stored report and the report is not read", async () => {
  const { store, calls } = storeOf({
    runnerOs: "ubuntu",
    receivedAt: new Date("2026-11-26T09:00:00.000Z"),
    report: storedReport(),
  });
  const { fetcher } = stubFetch(new Response(JSON.stringify(VALID), { status: 200 }));

  const read = await readProxyHealthOrReport({
    readEnv: async () => "http://127.0.0.1:41000",
    fetcher,
    store,
  });

  assert.equal(read.state, "reported");
  if (read.state !== "reported") return;
  assert.equal(read.source, "live", "a live client is the pool right now");
  assert.equal(calls.length, 0, "the stored report is only a fallback");
});

test("no client and no report says plainly that no Segment has reported", async () => {
  const { store } = storeOf(null);
  const { fetcher, calls } = stubFetch(new Error("should not be fetched"));

  const read = await readProxyHealthOrReport({
    readEnv: async () => undefined,
    fetcher,
    store,
  });

  assert.equal(calls.length, 0);
  assert.equal(read.state, "unconfigured");
  if (read.state !== "unconfigured") return;
  assert.equal(read.message, NO_POOL_REPORT_MESSAGE);
  assert.match(read.message, /No Segment has reported/);
});

test("an unreachable client with no report keeps its failure and adds the missing report", async () => {
  const { store } = storeOf(null);
  const { fetcher } = stubFetch(new Error("connect ECONNREFUSED 127.0.0.1:41000"));

  const read = await readProxyHealthOrReport({
    readEnv: async () => "http://127.0.0.1:41000",
    fetcher,
    store,
  });

  assert.equal(read.state, "unreachable");
  if (read.state !== "unreachable") return;
  assert.match(read.message, /could not be reached/i);
  assert.match(read.message, /No Segment has reported a pool yet/);
});

test("final is preferred over gate when both halves read the pool", () => {
  const health = healthFromPoolReport(
    storedReport({
      gate: { ...storedReport().gate, ready: 2, exits: REPORT_EXITS.slice(0, 2), refills: 1, reconnects: 0 },
      final: {
        ...storedReport().final!,
        ready: 3,
        exits: REPORT_EXITS,
        refills: 7,
        reconnects: 2,
      },
    }),
  );
  assert.equal(health.pool.length, 3, "the after-click exits are shown");
  assert.equal(health.refills, 7);
  assert.equal(health.reconnects, 2);
});

test("a final half that never read /health falls back to the gate, field for field", () => {
  const health = healthFromPoolReport(
    storedReport({
      gate: {
        ...storedReport().gate,
        lastError: { reason: "quota-spent", message: "the change bucket has nothing left", extra: 1 },
      },
      final: {
        ok: false,
        error: "no health report was read",
        checkedAt: "2026-11-26T09:00:00.000Z",
        ready: null,
        exits: [],
        refills: null,
        reconnects: null,
        lastError: null,
      },
    }),
  );
  assert.equal(health.pool.length, 3, "the gate's exits answer when final has none");
  assert.equal(health.refills, 1);
  assert.equal(health.reconnects, 0);
  assert.deepEqual(health.lastError, {
    reason: "quota-spent",
    message: "the change bucket has nothing left",
  });
});

test("a lastError that is not {reason, message} narrows to null rather than leaking a shape", () => {
  const health = healthFromPoolReport(
    storedReport({
      gate: {
        ...storedReport().gate,
        lastError: { reason: 42, message: ["not a string"] },
      },
      final: null,
    }),
  );
  assert.equal(health.lastError, null);
});

test("a stale report is named with its age and never judged live", async () => {
  const receivedAt = new Date("2026-11-26T00:00:00.000Z");
  const { store } = storeOf({
    runnerOs: "ubuntu",
    receivedAt,
    report: storedReport(),
  });

  const read = await readProxyHealthOrReport({ readEnv: async () => undefined, store });

  assert.equal(read.state, "reported");
  if (read.state !== "reported") return;
  assert.equal(read.source, "report", "a fallback never claims to be a live client");
  assert.equal(isProxyReportStale(read.receivedAt, NOW), true);
  assert.equal(proxyReportAge(read.receivedAt, new Date("2026-11-26T09:00:00.000Z")), "9 hours ago");
});
