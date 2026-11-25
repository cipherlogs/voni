/**
 * The client as the runner sees it: start it, read `/health`, act on the answer.
 *
 * These tests talk to the fake relay through the same client code production
 * runs, and to the real HTTP port the client binds — no proxy for the proxy.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeRelay } from "./fake-relay";
import { startTuxlerClient, type TuxlerHealth } from "./client";

const EMAIL = "operator@example.test";
const PASSWORD = "correct-horse-battery";

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
  });
  try {
    const health = await client.settled();
    assert.equal(health.ok, true);
    assert.equal(health.ready, true);
    assert.equal(health.account.tier, "free");
    assert.equal(health.buckets[0].limit, 7);
    assert.equal(health.buckets[0].remaining, 3);
    assert.equal(health.buckets[0].resetAt, "2026-11-26T13:26:00.000Z");
    assert.equal(health.account.clientIp, "203.0.113.9");
    assert.deepEqual(health.pool, []);
    assert.ok(health.session.frames.includes("TIMEVAL"));

    const live = await waitForHealth(client, (seen) => seen.buckets.length === 1);
    assert.equal(live.session.state, "connected");

    const body = await (await fetch(`${client.url}/health`)).text();
    assert.ok(!body.includes(EMAIL), "the health response leaked the account");
    assert.ok(!body.includes(PASSWORD), "the health response leaked the password");
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

test("closing the client stops the session and frees the health port", async () => {
  const relay = await FakeRelay.start({});
  const client = await startTuxlerClient({
    email: EMAIL,
    password: PASSWORD,
    resolveEndpoint: relay.resolve,
    health: { port: 0 },
  });
  const url = client.url;
  await client.settled();
  await client.close();
  await assert.rejects(fetch(`${url}/health`));
  assert.equal(client.health().session.state, "stopped");
  await relay.close();
});
