/**
 * The client as the runner sees it: start it, read `/health`, act on the answer.
 *
 * These tests talk to the fake relay through the same client code production
 * runs, and to the real HTTP port the client binds — no proxy for the proxy.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { FakeRelay } from "./fake-relay";
import { startTuxlerClient, type TuxlerHealth } from "./client";
import type { AsnRecord } from "./validate";

const EMAIL = "operator@example.test";
const PASSWORD = "correct-horse-battery";

/** The exit's ASN, injected: the tests must not resolve Team Cymru over the network. */
const CONSUMER: AsnRecord = {
  asn: 7018,
  prefix: "198.51.100.0/24",
  country: "US",
  name: "ATT-INTERNET4 - AT&T Services, Inc.",
};

async function waitForHealth(
  client: { health: () => TuxlerHealth },
  predicate: (health: TuxlerHealth) => boolean,
  timeoutMs = 2_000,
): Promise<TuxlerHealth> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = client.health();
    if (predicate(health)) return health;
    if (Date.now() > deadline) {
      throw new Error(`health never matched: ${JSON.stringify(health)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a started client answers health with the account's own figures and no credentials", async () => {
  const relay = await FakeRelay.start({ changesLimit: 7, changesUsed: 4, redirectServer: 3 });
  const client = await startTuxlerClient({
    email: EMAIL,
    password: PASSWORD,
    resolveEndpoint: relay.resolve,
    health: { port: 0 },
    pool: { target: 2, retryDelayMs: 100, lookup: async () => CONSUMER },
  });
  try {
    const health = await client.settled();
    assert.equal(health.ok, true);
    assert.equal(health.ready, false, "a session without an exit is not a usable client");
    assert.equal(health.account.tier, "free");
    assert.equal(health.buckets[0].limit, 7);
    assert.equal(health.buckets[0].remaining, 3);
    assert.equal(health.buckets[0].resetAt, "2026-11-26T13:26:00.000Z");
    assert.equal(health.account.clientIp, "203.0.113.9");
    assert.deepEqual(health.pool, [], "a handshake port is never an exit");
    assert.ok(health.session.frames.includes("TIMEVAL"));

    const live = await waitForHealth(client, (seen) => seen.pool.length === 2);
    assert.equal(live.ready, true);
    assert.equal(live.session.state, "connected");
    assert.equal(live.buckets.length, 1);
    for (const exit of live.pool) {
      assert.equal(exit.country, "US");
      assert.equal(exit.city, "Dallas");
      assert.equal(exit.state, "Texas");
      assert.equal(exit.asn, "7018");
    }

    const body = await (await fetch(`${client.url}/health`)).text();
    assert.ok(!body.includes(EMAIL), "the health response leaked the account");
    assert.ok(!body.includes(PASSWORD), "the health response leaked the password");
  } finally {
    await client.close();
    await relay.close();
  }
});

test("a client hands out a pooled exit and takes it back", async () => {
  const relay = await FakeRelay.start({});
  const client = await startTuxlerClient({
    email: EMAIL,
    password: PASSWORD,
    resolveEndpoint: relay.resolve,
    health: { port: 0 },
    // A low refill threshold keeps this test about the lease, not about refilling.
    pool: { target: 3, refillBelow: 1, retryDelayMs: 100, lookup: async () => CONSUMER },
  });
  try {
    await waitForHealth(client, (seen) => seen.pool.length === 3);
    const changes = relay.stats().changeRequests;
    const lease = await client.acquire();
    assert.match(lease.exitId, /^198\.51\.100\.\d+:\d+$/);
    assert.equal(lease.country, "US");
    assert.equal(lease.server, "server1.ipsharkk.com");
    assert.equal(relay.stats().changeRequests, changes, "an acquire spends no change");

    const offered = client.health().pool.map((exit) => exit.exitId);
    assert.equal(offered.length, 2, "a leased exit is not offered to another Click");
    assert.equal(offered.includes(lease.exitId), false);

    await client.release(lease.exitId, "good");
    await waitForHealth(client, (seen) => seen.pool.length === 3);
    assert.equal(relay.stats().changeRequests, changes, "a good release spends nothing");
  } finally {
    await client.close();
    await relay.close();
  }
});

test("a missing credential fails the health state without opening a socket", async () => {
  const relay = await FakeRelay.start({});
  const client = await startTuxlerClient({
    resolveEndpoint: relay.resolve,
    health: { port: 0 },
  });
  try {
    const health = await client.settled();
    assert.equal(health.ok, false);
    assert.equal(health.ready, false);
    assert.equal(health.lastError?.reason, "credential-missing");
    assert.equal(relay.stats().controlConnections, 0);
    assert.equal(client.pool(), null);
    await assert.rejects(client.acquire({ waitMs: 50 }), /not ready|no live session/);
  } finally {
    await client.close();
    await relay.close();
  }
});

test("a wrong password fails the health state once, not in a loop", async () => {
  const relay = await FakeRelay.start({});
  const client = await startTuxlerClient({
    email: EMAIL,
    password: "wrong-password",
    resolveEndpoint: relay.resolve,
    health: { port: 0 },
  });
  try {
    const health = await client.settled();
    assert.equal(health.ok, false);
    assert.equal(health.lastError?.reason, "login-rejected");
    assert.ok(!JSON.stringify(health).includes("wrong-password"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(relay.stats().loginAttempts, 1);
    assert.equal(client.health().lastError?.reason, "login-rejected");
  } finally {
    await client.close();
    await relay.close();
  }
});

test("a socket that drops after login turns the health state into a failure", async () => {
  const relay = await FakeRelay.start({ dropAfterLoginMs: 40 });
  const client = await startTuxlerClient({
    email: EMAIL,
    password: PASSWORD,
    resolveEndpoint: relay.resolve,
    health: { port: 0 },
  });
  try {
    await client.settled();
    const failed = await waitForHealth(client, (health) => health.ok === false);
    assert.equal(failed.session.state, "failed");
    assert.equal(failed.lastError?.reason, "socket-closed");
  } finally {
    await client.close();
    await relay.close();
  }
});

test("closing the client stops the session, frees the health port and every exit", async () => {
  const relay = await FakeRelay.start({});
  const client = await startTuxlerClient({
    email: EMAIL,
    password: PASSWORD,
    resolveEndpoint: relay.resolve,
    health: { port: 0 },
    pool: { target: 2, retryDelayMs: 100, lookup: async () => CONSUMER },
  });
  const url = client.url;
  await client.settled();
  const filled = await waitForHealth(client, (seen) => seen.pool.length === 2);
  const ports = client
    .pool()
    ?.snapshot()
    .exits.map((exit) => exit.localPort);
  assert.equal(ports?.length, 2);
  assert.equal(filled.pool.length, 2);

  await client.close();
  await assert.rejects(fetch(`${url}/health`));
  assert.equal(client.health().session.state, "stopped");
  assert.equal(client.pool(), null);
  for (const port of ports ?? []) {
    const socket = net.connect({ host: "127.0.0.1", port });
    await assert.rejects(once(socket, "connect"), `port ${port} outlived the client`);
    socket.destroy();
  }
  await relay.close();
});
