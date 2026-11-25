/**
 * The health report: the only thing the runner and the console read.
 *
 * Two promises are checked here. It answers what the account itself reported —
 * the limit from `LIMITS_INFO`, never a hardcoded ten — and it can be served on a
 * loopback port while carrying no credential and no full account identifier.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { emptyAccountState, type TuxlerAccountState } from "./account";
import { buildHealth, bucketId, startHealthServer, type ControlExit, type HealthInput } from "./health";
import { PoolUnavailableError } from "./pool";
import type { SessionSnapshot } from "./control";

const EMAIL = "operator@example.test";
const CLIENT_IP = "203.0.113.9";

function account(overrides: Partial<TuxlerAccountState> = {}): TuxlerAccountState {
  return {
    ...emptyAccountState(),
    tier: "free",
    premium: false,
    changesUsed: 4,
    changesLimit: 7,
    resetAt: "2026-11-26T13:26:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    state: "connected",
    host: "server3.ipsharkk.com",
    handshakeMs: 812,
    heartbeatSeconds: 50,
    clientIp: CLIENT_IP,
    silentForMs: 12,
    frames: ["CONNECT_LIST", "MAKE_TEST_1", "TIMEVAL", "YOUR_IP"],
    account: account(),
    failure: null,
    ...overrides,
  };
}

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    state: "connected",
    snapshot: snapshot(),
    bucketId: bucketId(EMAIL, CLIENT_IP),
    lastError: null,
    ...overrides,
  };
}

test("a live session reports the account's own limit, usage and reset time", () => {
  const health = buildHealth(input());
  assert.equal(health.ok, true);
  assert.equal(health.ready, true);
  assert.deepEqual(health.pool, [], "a handshake port is never an exit");
  assert.equal(health.lastError, null);
  assert.equal(health.account.tier, "free");
  assert.equal(health.account.clientIp, CLIENT_IP);
  assert.deepEqual(health.buckets, [
    {
      clientIpHash: bucketId(EMAIL, CLIENT_IP),
      used: 4,
      limit: 7,
      remaining: 3,
      resetAt: "2026-11-26T13:26:00.000Z",
    },
  ]);
  assert.equal(health.session.state, "connected");
  assert.deepEqual(health.session.frames, [
    "CONNECT_LIST",
    "MAKE_TEST_1",
    "TIMEVAL",
    "YOUR_IP",
  ]);
  assert.equal(health.session.heartbeatSeconds, 50);
  assert.equal(health.session.handshakeMs, 812);
});

test("a pooled client reports its exits and the refills it spent reaching them", () => {
  // The run artifact names exits, cities, ASNs and refill counts; refills are
  // the pool's own counter, so health has to carry it rather than the runner
  // inferring one from reconnects.
  const health = buildHealth(
    input({
      pool: {
        ready: 1,
        exits: [
          {
            exitId: "198.51.100.24:4107",
            ip: "198.51.100.24",
            country: "US",
            asn: "7018",
            city: "Dallas",
            state: "Texas",
          },
        ],
        buckets: [
          {
            clientIpHash: bucketId(EMAIL, CLIENT_IP),
            used: 4,
            limit: 7,
            remaining: 3,
            resetAt: "2026-11-26T13:26:00.000Z",
          },
        ],
        refills: 6,
        reconnects: 1,
      },
    }),
  );
  assert.equal(health.refills, 6);
  assert.equal(health.reconnects, 1);
  assert.equal(health.ready, true);
  assert.equal(health.pool[0].city, "Dallas");
});

test("an unlimited meter reports no limit and no remaining count", () => {
  const health = buildHealth(
    input({ snapshot: snapshot({ account: account({ changesLimit: -1 }) }) }),
  );
  assert.equal(health.buckets[0].limit, null);
  assert.equal(health.buckets[0].remaining, null);
  assert.equal(health.buckets[0].used, 4);
});

test("before the limits frame arrives there is no bucket to report", () => {
  const health = buildHealth(
    input({ snapshot: snapshot({ account: emptyAccountState(), clientIp: null }) }),
  );
  assert.deepEqual(health.buckets, []);
  assert.equal(health.account.tier, "unknown");
});

test("a failed session is not ok, not ready, and carries the reason", () => {
  const health = buildHealth(
    input({
      state: "failed",
      snapshot: snapshot({
        state: "failed",
        failure: { reason: "relay-silent", message: "the relay sent nothing for 60000 ms" },
      }),
      lastError: { reason: "relay-silent", message: "the relay sent nothing for 60000 ms" },
    }),
  );
  assert.equal(health.ok, false);
  assert.equal(health.ready, false);
  assert.equal(health.lastError?.reason, "relay-silent");
});

test("a client that never opened a session still answers with a reason", () => {
  const health = buildHealth(
    input({
      state: "failed",
      snapshot: null,
      bucketId: null,
      lastError: { reason: "credential-missing", message: "no relay credential configured" },
    }),
  );
  assert.equal(health.ok, false);
  assert.equal(health.ready, false);
  assert.equal(health.session.state, "failed");
  assert.equal(health.lastError?.reason, "credential-missing");
  assert.deepEqual(health.buckets, []);
});

test("the bucket identifier is derived and reversible to nobody", () => {
  const id = bucketId(EMAIL, CLIENT_IP);
  assert.equal(id, bucketId(EMAIL, CLIENT_IP));
  assert.notEqual(id, bucketId(EMAIL, "198.51.100.7"));
  assert.notEqual(id, bucketId("someone-else@example.test", CLIENT_IP));
  assert.ok(!id.includes(EMAIL));
  assert.ok(!id.includes(CLIENT_IP));
  assert.ok(!id.includes("example.test"));
});

test("the health endpoint answers on loopback and refuses any other bind", async () => {
  await assert.rejects(
    startHealthServer({ host: "0.0.0.0", port: 0, snapshot: () => buildHealth(input()) }),
    /loopback/i,
  );
  const server = await startHealthServer({ port: 0, snapshot: () => buildHealth(input()) });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${server.url}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as ReturnType<typeof buildHealth>;
    assert.equal(body.session.state, "connected");
    assert.equal(body.buckets[0].limit, 7);
    assert.equal(
      (await fetch(`${server.url}/acquire`)).status,
      503,
      "a client without a pool says it is not ready instead of leaking a 404",
    );
    assert.equal((await fetch(`${server.url}/health`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${server.url}/health`)).headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
  }
});

const CONTROL_EXIT: ControlExit = {
  exitId: "198.51.100.24:4107",
  server: "server1.ipsharkk.com",
  ip: "198.51.100.24",
  country: "US",
  asn: "7018",
  city: "Dallas",
  state: "Texas",
  socksUrl: "socks5h://127.0.0.1:4107",
  localPort: 4107,
};

test("the control API hands one exit out and takes it back with its outcome", async () => {
  const waits: number[] = [];
  const released: Array<{ exitId: string; outcome: string }> = [];
  const server = await startHealthServer({
    port: 0,
    snapshot: () => buildHealth(input()),
    acquire: async ({ waitMs }) => {
      waits.push(waitMs);
      return CONTROL_EXIT;
    },
    release: async (exitId, outcome) => {
      released.push({ exitId, outcome });
    },
  });
  try {
    const response = await fetch(`${server.url}/acquire?waitMs=9000`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), CONTROL_EXIT);
    assert.deepEqual(waits, [9000], "the Click's own bounded wait reaches the pool");

    const release = await fetch(`${server.url}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exitId: CONTROL_EXIT.exitId, ok: false }),
    });
    assert.equal(release.status, 204);
    assert.equal(await release.text(), "");
    assert.deepEqual(released, [{ exitId: CONTROL_EXIT.exitId, outcome: "failed" }]);
  } finally {
    await server.close();
  }
});

test("an acquire the pool cannot serve is a 503 with the reason, not a Click", async () => {
  const server = await startHealthServer({
    port: 0,
    snapshot: () => buildHealth(input()),
    acquire: async () => {
      throw new PoolUnavailableError("no-us-exit", "no US exit could be obtained");
    },
    release: async () => {},
  });
  try {
    const response = await fetch(`${server.url}/acquire?waitMs=10000`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { reason: "no-us-exit" });
  } finally {
    await server.close();
  }
});

test("the control API refuses a malformed acquire wait or release body", async () => {
  const server = await startHealthServer({
    port: 0,
    snapshot: () => buildHealth(input()),
    acquire: async () => CONTROL_EXIT,
    release: async () => {},
  });
  try {
    assert.equal((await fetch(`${server.url}/acquire?waitMs=soon`)).status, 400);
    assert.equal((await fetch(`${server.url}/acquire`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${server.url}/release`)).status, 405);

    const notJson = await fetch(`${server.url}/release`, {
      method: "POST",
      body: "{",
    });
    assert.equal(notJson.status, 400);

    for (const body of [
      {},
      { exitId: "", ok: true },
      { exitId: "198.51.100.24:4107", ok: "yes" },
      { exitId: 42, ok: true },
    ]) {
      const response = await fetch(`${server.url}/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, `${JSON.stringify(body)} was accepted`);
    }

    const oversized = await fetch(`${server.url}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exitId: "x".repeat(2_000), ok: true }),
    });
    assert.equal(oversized.status, 413, "a release body is bounded, not buffered");
  } finally {
    await server.close();
  }
});
