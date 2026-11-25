/**
 * The pool: five ready exits, refilled when fewer than three remain, never above
 * eight, and a lease contract the runner can spend a Click on.
 *
 * Every test runs the real session, the real change command, the real validator
 * and a real SOCKS listener against the fake relay. The numbers asserted are the
 * ticket's: target five, refill below three, hard maximum eight, a ten-second
 * acquire wait. The change counter is the fake relay's own, so "a refill spends a
 * change and an acquire does not" is measured on the wire, not inferred.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { FakeRelay, type FakeChange } from "./fake-relay";
import { startSession, type TuxlerSession } from "./control";
import {
  POOL_ACQUIRE_WAIT_MS,
  POOL_MAX,
  POOL_REFILL_BELOW,
  POOL_TARGET,
  PoolUnavailableError,
  createExitPool,
  type ExitPool,
  type PoolSnapshot,
} from "./pool";
import { buildHealth } from "./health";
import type { AsnRecord } from "./validate";

const EMAIL = "operator@example.test";
const PASSWORD = "correct-horse-battery";

const CONSUMER: AsnRecord = {
  asn: 7018,
  prefix: "198.51.100.0/24",
  country: "US",
  name: "ATT-INTERNET4 - AT&T Services, Inc.",
};

/** Distinct addresses, so "five different exits" cannot pass on ports alone. */
function distinctChanges(count = 12, ip?: string): FakeChange[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "changed" as const,
    ip: ip ?? `198.51.100.${10 + index}`,
  }));
}

async function withRelay(
  options: Parameters<typeof FakeRelay.start>[0],
  run: (relay: FakeRelay) => Promise<void>,
): Promise<void> {
  const relay = await FakeRelay.start(options);
  try {
    await run(relay);
  } finally {
    await relay.close();
  }
}

async function connect(relay: FakeRelay): Promise<TuxlerSession> {
  return startSession({
    host: "server1.ipsharkk.com",
    port: 29990,
    email: EMAIL,
    password: PASSWORD,
    resolveEndpoint: relay.resolve,
  });
}

function makePool(
  relay: FakeRelay,
  session: TuxlerSession,
  overrides: Partial<Parameters<typeof createExitPool>[0]> = {},
): ExitPool {
  return createExitPool({
    session,
    relayHost: "server1.ipsharkk.com",
    resolveEndpoint: relay.resolve,
    lookup: async () => CONSUMER,
    bucketId: () => "bucket-root",
    retryDelayMs: 150,
    // The spec's cooldown is twenty seconds; the tests only need to see that the
    // sixth change waits at all, so the tuning is short here.
    paceCooldownMs: 50,
    changeTimeoutMs: 2_000,
    ...overrides,
  });
}

async function waitFor(
  pool: ExitPool,
  predicate: (snapshot: PoolSnapshot) => boolean,
  timeoutMs = 8_000,
): Promise<PoolSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = pool.snapshot();
    if (predicate(snapshot)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`pool never matched: ${JSON.stringify(snapshot)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether nothing is listening on the port: a fresh bind succeeds. */
async function assertPortFree(port: number, inUseBy: Set<number>): Promise<void> {
  if (inUseBy.has(port)) return;
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch {
    assert.fail(`port ${port} is still bound after the listener was closed`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function unreachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

test("the pool reaches five ready exits on its own, one change each", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      const snapshot = await waitFor(pool, (seen) => seen.ready === POOL_TARGET);

      assert.equal(relay.stats().changeRequests, POOL_TARGET, "five exits, five changes");
      assert.equal(snapshot.total, POOL_TARGET);
      assert.equal(new Set(snapshot.exits.map((exit) => exit.exitId)).size, POOL_TARGET);
      assert.equal(snapshot.target, 5);
      assert.equal(snapshot.refillBelow, POOL_REFILL_BELOW);
      assert.equal(snapshot.max, POOL_MAX);

      const exit = snapshot.exits[0];
      assert.equal(exit.country, "US");
      assert.equal(exit.state, "Texas", "the US state comes from the reply's region");
      assert.equal(exit.city, "Dallas");
      assert.equal(exit.asn, "7018");
      assert.equal(exit.status, "ready");
      assert.ok(exit.localPort > 0);

      assert.equal(snapshot.buckets.length, 1);
      assert.equal(snapshot.buckets[0].used, 3, "the account's own usage");
      assert.equal(snapshot.buckets[0].limit, 10, "the account's own limit");
      assert.equal(snapshot.lastError, null);
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("five acquires hand out five different exits without a change per acquire", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      assert.equal(relay.stats().changeRequests, 5, "the fill spent five");

      const leases = [];
      for (let index = 0; index < 5; index += 1) leases.push(await pool.acquire());
      assert.equal(
        new Set(leases.map((lease) => lease.exitId)).size,
        5,
        "five clicks, five different exits",
      );
      assert.equal(new Set(leases.map((lease) => lease.ip)).size, 5);
      for (const lease of leases) {
        assert.equal(lease.country, "US");
        assert.equal(lease.server, "server1.ipsharkk.com");
        assert.match(lease.socksUrl, /^socks5h:\/\/127\.0\.0\.1:\d+$/);
        assert.ok(lease.localPort > 0);
        assert.equal(lease.asn, "7018");
      }

      // The pool refills behind the leases, capped at eight live exits.
      const filled = await waitFor(pool, (seen) => seen.total === POOL_MAX);
      assert.equal(filled.ready, 3);
      assert.equal(relay.stats().changeRequests, 8, "three refills, not one change per acquire");
      assert.equal(
        filled.total,
        relay.stats().changeRequests,
        "every change made exactly one exit; nothing was spent on an acquire",
      );

      for (const lease of leases) await pool.release(lease.exitId, "good");
      const restored = await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      assert.equal(restored.total, POOL_TARGET, "surplus drains back to the target");
      assert.equal(relay.stats().changeRequests, 8, "a release spends nothing");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a refill starts only below three ready and returns to the target", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === POOL_TARGET);

      const first = await pool.acquire();
      const second = await pool.acquire();
      await pause(150);
      assert.equal(relay.stats().changeRequests, 5, "three ready is still above the threshold");
      assert.equal(pool.snapshot().ready, POOL_REFILL_BELOW);

      const third = await pool.acquire();
      const refilled = await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      assert.equal(refilled.total, POOL_MAX);
      assert.equal(relay.stats().changeRequests, 8, "refilled to the target, then stopped");

      for (const lease of [first, second, third]) await pool.release(lease.exitId, "good");
      await waitFor(pool, (seen) => seen.ready === POOL_TARGET && seen.total === POOL_TARGET);
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("the hard maximum of eight holds, and a refusal leaves nothing behind", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      const leases = [];
      for (let index = 0; index < POOL_TARGET; index += 1) leases.push(await pool.acquire());
      await waitFor(pool, (seen) => seen.total === POOL_MAX);
      const atMax = relay.stats().changeRequests;
      assert.equal(atMax, POOL_MAX);

      const held = [];
      for (let index = 0; index < 3; index += 1) held.push(await pool.acquire());
      assert.equal(pool.snapshot().ready, 0);

      await assert.rejects(pool.acquire({ waitMs: 200 }), (error: unknown) => {
        assert.ok(error instanceof PoolUnavailableError);
        assert.equal(error.reason, "not-ready");
        return true;
      });
      const now = pool.snapshot();
      assert.equal(now.total, POOL_MAX, "never above eight");
      assert.equal(relay.stats().changeRequests, atMax, "a refusal spends no change");
      assert.equal(now.exits.length, POOL_MAX, "no leaked or half-open exit");

      for (const lease of [...leases, ...held]) await pool.release(lease.exitId, "good");
      const restored = await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      assert.equal(restored.total, POOL_TARGET);
      assert.equal(relay.stats().changeRequests, atMax);
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("an acquire tells no US exit, quota spent and relay silence apart", async () => {
  const cases: Array<[FakeChange, string]> = [
    [{ kind: "not-available" }, "no-us-exit"],
    [{ kind: "overloaded" }, "no-us-exit"],
    [{ kind: "incomplete" }, "no-us-exit"],
    [{ kind: "limit" }, "quota-spent"],
    [{ kind: "not-entitled" }, "quota-spent"],
    [{ kind: "silent" }, "relay-silent"],
  ];
  for (const [change, reason] of cases) {
    await withRelay({ changes: [change] }, async (relay) => {
      const session = await connect(relay);
      const pool = makePool(relay, session, { changeTimeoutMs: 150, retryDelayMs: 50 });
      try {
        pool.start();
        await assert.rejects(pool.acquire({ waitMs: 600 }), (error: unknown) => {
          assert.ok(error instanceof PoolUnavailableError, `${reason}: a typed failure`);
          assert.equal(error.reason, reason);
          return true;
        });
        assert.equal(pool.snapshot().ready, 0, `${reason}: nothing is served`);
      } finally {
        await pool.close();
        session.stop();
      }
    });
  }
});

test("a pool that has not started reports not-ready rather than an empty supply", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      await assert.rejects(pool.acquire({ waitMs: 100 }), (error: unknown) => {
        assert.ok(error instanceof PoolUnavailableError);
        assert.equal(error.reason, "not-ready");
        return true;
      });
      assert.equal(relay.stats().changeRequests, 0, "a wait never spends a change");
      assert.equal(POOL_ACQUIRE_WAIT_MS, 10_000, "the default wait is ten seconds");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a failed release counts a strike, the second kills the exit and its listener", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === POOL_TARGET);

      const lease = await pool.acquire();
      await pool.release(lease.exitId, "failed");
      const struck = pool.snapshot();
      const entry = struck.exits.find((exit) => exit.exitId === lease.exitId);
      assert.ok(entry, "one strike does not remove the exit");
      assert.equal(entry.status, "ready");
      assert.equal(entry.strikes, 1);
      assert.equal(await unreachable(lease.localPort), false, "its listener stays open");
      assert.equal(relay.stats().changeRequests, 5, "a strike spends nothing");

      const same = await pool.acquire();
      assert.equal(same.exitId, lease.exitId, "the struck exit is handed out again");
      await pool.release(lease.exitId, "good");
      const forgiven = pool.snapshot().exits.find((exit) => exit.exitId === lease.exitId);
      assert.equal(forgiven?.strikes, 0, "a good release clears the strike");

      await pool.release(lease.exitId, "failed");
      await pool.release(lease.exitId, "failed");
      const killed = pool.snapshot();
      assert.equal(
        killed.exits.some((exit) => exit.exitId === lease.exitId),
        false,
        "the second strike kills the exit",
      );
      assert.equal(await unreachable(lease.localPort), true, "and closes its listener");

      const replaced = await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      assert.equal(replaced.total, POOL_TARGET);
      assert.equal(relay.stats().changeRequests, 6, "the death triggered one replacement");

      await assert.rejects(pool.release("198.51.100.10:1", "good"));
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("health reports every exit and every bucket, and reading it changes nothing", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      // Nothing started: health must not start the fill.
      for (let index = 0; index < 20; index += 1) {
        pool.snapshot();
        pool.health();
      }
      assert.equal(relay.stats().changeRequests, 0, "reading health never spends a change");
      assert.equal(pool.snapshot().ready, 0);

      pool.start();
      const snapshot = await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      const before = relay.stats().changeRequests;
      const ids = snapshot.exits.map((exit) => exit.exitId).sort();

      for (let index = 0; index < 20; index += 1) {
        const health = buildHealth({
          state: "connected",
          snapshot: session.snapshot(),
          bucketId: "bucket-root",
          lastError: null,
          pool: pool.health(),
        });
        assert.equal(health.ready, true);
        assert.equal(health.pool.length, snapshot.ready);
        assert.equal(health.buckets.length, 1);
        assert.equal(health.buckets[0].used, 3);
        assert.equal(health.buckets[0].limit, 10);
        const exit = health.pool[0];
        assert.equal(exit.country, "US");
        assert.equal(exit.state, "Texas");
        assert.equal(exit.city, "Dallas");
        assert.equal(exit.asn, "7018");
        assert.match(exit.ip, /^198\.51\.100\./);
      }
      await pause(100);
      assert.equal(relay.stats().changeRequests, before, "still no change spent");
      assert.deepEqual(
        pool.snapshot().exits.map((exit) => exit.exitId).sort(),
        ids,
        "and no exit was replaced",
      );
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("restarting the pool closes every listener it owned, so no port is stranded", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      const snapshot = await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      const oldPorts = snapshot.exits.map((exit) => exit.localPort);
      assert.equal(new Set(oldPorts).size, POOL_TARGET);

      await pool.restart();

      const restarted = await waitFor(pool, (seen) => seen.ready === POOL_TARGET);
      const newPorts = new Set(restarted.exits.map((exit) => exit.localPort));
      assert.equal(restarted.total, POOL_TARGET, "a restart leaves no ghost exits");
      for (const port of oldPorts) {
        assert.equal(newPorts.has(port), false, `port ${port} was handed back for reuse`);
        await assertPortFree(port, newPorts);
      }
      assert.equal(relay.stats().changeRequests, 10, "a restart fills a fresh pool");

      await pool.close();
      for (const port of newPorts) await assertPortFree(port, new Set());
    } finally {
      session.stop();
    }
  });
});
