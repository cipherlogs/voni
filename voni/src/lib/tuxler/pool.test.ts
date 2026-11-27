/**
 * The pool: one live exit, rotated on release, with a lease contract the runner
 * can spend a Click on.
 *
 * Tuxler kills the previous exit the moment its session asks for another change,
 * so a pool of ready exits would serve dead ports. Every test runs the real
 * session, the real change command, the real validator and a real SOCKS listener
 * against the fake relay. The change counter is the fake relay's own, so "a lease
 * spends no change and a good release spends exactly one" is measured on the wire,
 * not inferred.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { FakeRelay, type FakeChange } from "./fake-relay";
import { startSession, type TuxlerSession } from "./control";
import {
  POOL_ACQUIRE_WAIT_MS,
  POOL_LIVE_EXITS,
  POOL_NO_PROGRESS_REFILLS,
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

test("the pool holds one live exit even when the console asked for five", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      const snapshot = await waitFor(pool, (seen) => seen.ready === POOL_LIVE_EXITS);

      assert.equal(relay.stats().changeRequests, 1, "one live exit costs one change");
      assert.equal(snapshot.total, 1, "the pool never holds a second exit");
      assert.equal(snapshot.liveExitLimit, 1, "the cap is reported, not silently obeyed");
      assert.equal(snapshot.target, 1, "the requested five is capped to the live limit");
      assert.equal(snapshot.max, 1);
      assert.equal(snapshot.refillBelow, 1);

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

test("a failing ASN lookup parks the pool instead of spending change after change", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, {
      // A classifier outage: the address cannot be identified, so no exit can be
      // accepted. This is not thin supply and another change cannot fix it.
      lookup: async () => ({ asn: 0, prefix: "", country: null, name: null }),
      retryDelayMs: 10,
      paceCooldownMs: 10,
    });
    try {
      pool.start();
      const snapshot = await waitFor(pool, (seen) => seen.lastError !== null);
      assert.equal(snapshot.ready, 0);
      assert.equal(snapshot.lastError?.reason, "lookup-failed");
      assert.equal(snapshot.parked, true, "a parked pool must say so, not look idle");
      assert.equal(snapshot.parkedFor, "hard");

      // Give the retry loop every chance to spend again before asserting it did not.
      await pause(300);
      assert.equal(
        relay.stats().changeRequests,
        1,
        "a rejection the next change cannot fix must park the pool, not drain the bucket",
      );
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a good release retires the exit, and exactly one change replaces it", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    // The console's three-to-eight settings still validate; the pool caps them.
    const pool = makePool(relay, session, { target: 5, refillBelow: 3, max: 8 });
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);
      assert.equal(relay.stats().changeRequests, 1, "the fill spent one change");

      const first = await pool.acquire();
      assert.equal(relay.stats().changeRequests, 1, "a lease spends no change");
      assert.equal(pool.snapshot().ready, 0, "the leased exit is not offered to another Click");

      await pool.release(first.exitId, "good");
      const after = await waitFor(pool, (seen) => seen.ready === 1);
      assert.equal(relay.stats().changeRequests, 2, "the release spent exactly one change");
      assert.equal(after.total, 1, "and still holds one exit");
      assert.notEqual(after.exits[0].exitId, first.exitId, "the replacement is a different exit");
      assert.equal(
        await unreachable(first.localPort),
        true,
        "the retired exit's listener is closed, not left for a dead port",
      );
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("two overlapping acquires are serialized, and the second gets a different exit", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, { target: 3, acquireWaitMs: 3_000 });
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);

      const first = await pool.acquire();
      let settled = false;
      const secondPromise = pool.acquire().then((lease) => {
        settled = true;
        return lease;
      });
      await pause(150);
      assert.equal(settled, false, "the second lease waits while the first is outstanding");
      assert.equal(relay.stats().changeRequests, 1, "waiting spends no change");

      await pool.release(first.exitId, "good");
      const second = await secondPromise;
      assert.notEqual(second.exitId, first.exitId, "the second Click never gets the first's port");
      assert.equal(await unreachable(first.localPort), true);
      assert.equal(relay.stats().changeRequests, 2, "one change replaced the retired exit");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a second acquire times out as PoolUnavailableError while the first is held", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, { acquireWaitMs: 150 });
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);
      const held = await pool.acquire();

      await assert.rejects(pool.acquire(), (error: unknown) => {
        assert.ok(error instanceof PoolUnavailableError, "the wait fails loudly, never with a lease");
        assert.equal(error.reason, "not-ready");
        return true;
      });
      assert.equal(relay.stats().changeRequests, 1, "neither the lease nor the timeout spent a change");

      await pool.release(held.exitId, "good");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a failed release keeps the exit on one strike and retires it on the second", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);

      const lease = await pool.acquire();
      await pool.release(lease.exitId, "failed");
      const struck = pool.snapshot();
      const entry = struck.exits.find((exit) => exit.exitId === lease.exitId);
      assert.ok(entry, "one strike does not remove the exit");
      assert.equal(entry.status, "ready");
      assert.equal(entry.strikes, 1);
      assert.equal(await unreachable(lease.localPort), false, "its listener stays open");
      assert.equal(relay.stats().changeRequests, 1, "a strike spends nothing");

      await pool.release(lease.exitId, "failed");
      const killed = pool.snapshot();
      assert.equal(
        killed.exits.some((exit) => exit.exitId === lease.exitId),
        false,
        "the second strike retires the exit",
      );
      assert.equal(await unreachable(lease.localPort), true, "and closes its listener");

      const replaced = await waitFor(pool, (seen) => seen.ready === 1);
      assert.equal(replaced.total, 1);
      assert.equal(relay.stats().changeRequests, 2, "the death triggered one replacement");

      await assert.rejects(pool.release("198.51.100.10:1", "good"));
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
      assert.ok(
        POOL_ACQUIRE_WAIT_MS >= 20_000,
        "the default wait covers one change, including a silent one",
      );
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a good release clears a strike but still retires the exit it served", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session);
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);

      const lease = await pool.acquire();
      await pool.release(lease.exitId, "failed");
      assert.equal(
        pool.snapshot().exits.find((exit) => exit.exitId === lease.exitId)?.strikes,
        1,
        "one strike is recorded",
      );

      // A good release forgives the strike but retires the exit: the replacement
      // refill's change would kill its port regardless, so it cannot be reused.
      await pool.release(lease.exitId, "good");
      assert.equal(
        pool.snapshot().exits.some((exit) => exit.exitId === lease.exitId),
        false,
        "a good release retires the struck exit",
      );
      const replaced = await waitFor(pool, (seen) => seen.ready === 1);
      assert.notEqual(replaced.exits[0].exitId, lease.exitId);
      assert.equal(relay.stats().changeRequests, 2, "the replacement cost one change");
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
      const snapshot = await waitFor(pool, (seen) => seen.ready === 1);
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
        assert.equal(health.liveExitLimit, 1, "health explains why the pool holds one exit");
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
      const snapshot = await waitFor(pool, (seen) => seen.ready === 1);
      const oldPorts = snapshot.exits.map((exit) => exit.localPort);
      assert.equal(new Set(oldPorts).size, 1);

      await pool.restart();

      const restarted = await waitFor(pool, (seen) => seen.ready === 1);
      const newPorts = new Set(restarted.exits.map((exit) => exit.localPort));
      assert.equal(restarted.total, 1, "a restart leaves no ghost exits");
      for (const port of oldPorts) {
        assert.equal(newPorts.has(port), false, `port ${port} was handed back for reuse`);
        await assertPortFree(port, newPorts);
      }
      assert.equal(relay.stats().changeRequests, 2, "a restart fills a fresh pool");

      await pool.close();
      for (const port of newPorts) await assertPortFree(port, new Set());
    } finally {
      session.stop();
    }
  });
});

test("a pool that refills and never accepts parks itself with a stated cause", async () => {
  await withRelay({ changes: [{ kind: "not-available" }] }, async (relay) => {
    const session = await connect(relay);
    const lines: string[] = [];
    const pool = makePool(relay, session, {
      target: 3,
      noProgressRefills: 3,
      retryDelayMs: 10,
      paceCooldownMs: 10,
      log: (line) => lines.push(line),
    });
    try {
      pool.start();
      const deadline = Date.now() + 8_000;
      for (;;) {
        const seen = pool.snapshot();
        // Before the first refill there is nothing to report. From then on a
        // zero-exit pool always carries either the refusal or the park: the
        // `ready: 0, parked: false, lastError: null` shape is the bug.
        if (seen.refills > 0 && seen.ready === 0) {
          assert.ok(
            seen.parked || seen.lastError !== null,
            `silent stall: ${JSON.stringify(seen)}`,
          );
        }
        if (seen.parked) break;
        assert.ok(Date.now() < deadline, `never parked: ${JSON.stringify(seen)}`);
        await pause(10);
      }

      const parked = pool.snapshot();
      assert.equal(parked.ready, 0);
      assert.equal(parked.parked, true, "a pool that cannot accept an exit must not look idle");
      assert.equal(parked.parkedFor, "hard", "no supply after eight refusals is not quota");
      assert.equal(
        parked.refills,
        3,
        "the stall rule stops at its threshold rather than draining the allowance",
      );
      assert.equal(relay.stats().changeRequests, 3);
      assert.equal(parked.lastError?.reason, "not-available");
      assert.match(
        parked.lastError?.message ?? "",
        /no exit was accepted in 3 refill\(s\) in a row/,
      );
      assert.match(parked.lastError?.message ?? "", /change\(s\)/);
      assert.match(
        parked.lastError?.message ?? "",
        /the relay said: no US exit is available right now/,
        "the report quotes the relay's own refusal",
      );

      // `/health` is the seam the gate reads: parked, and carrying the reason.
      const health = buildHealth({
        state: "connected",
        snapshot: session.snapshot(),
        bucketId: "bucket-root",
        lastError: null,
        pool: pool.health(),
      });
      assert.equal(health.ready, false);
      assert.equal(health.parked, true);
      assert.equal(health.lastError?.reason, "not-available");

      // One line per refill, and nothing a log artifact should not keep.
      const refillLines = lines.filter((line) => line.startsWith("refill #"));
      assert.equal(refillLines.length, 3, "every refill wrote exactly one line");
      for (const line of [...refillLines, ...lines.filter((l) => l.startsWith("parked"))]) {
        assert.equal(line.includes("\n"), false, "a log line is one line");
        assert.equal(line.includes(EMAIL), false, "the pool log holds no account");
        assert.equal(line.includes(PASSWORD), false, "the pool log holds no password");
      }
      assert.match(
        refillLines[0]!,
        /^refill #1 depth=0 outcome=retry reason=not-available message=".+ entries=0 ready=0$/,
        "attempt number, outcome, refusal and the pool's own counts",
      );
      assert.ok(
        lines.some((line) => /^parked for=hard reason=not-available after 3 refill\(s\): /.test(line)),
        "the park is logged with its cause",
      );
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("an account out of changes parks as quota instead of waiting silently", async () => {
  await withRelay({ changes: [{ kind: "limit" }] }, async (relay) => {
    const session = await connect(relay);
    const lines: string[] = [];
    const pool = makePool(relay, session, {
      target: 3,
      retryDelayMs: 10,
      log: (line) => lines.push(line),
    });
    try {
      pool.start();
      const parked = await waitFor(pool, (seen) => seen.parked);
      assert.equal(parked.ready, 0);
      assert.equal(parked.parkedFor, "quota");
      assert.equal(parked.lastError?.reason, "limit");
      assert.match(parked.lastError?.message ?? "", /change\(s\) spent/);
      assert.match(
        parked.lastError?.message ?? "",
        /the bucket's change limit is spent/,
        "the report says what the relay said, not only that nothing is ready",
      );
      await pause(200);
      assert.ok(
        relay.stats().changeRequests <= 2,
        "a spent account is not retried into more changes",
      );
      assert.ok(
        lines.some((line) => line.startsWith("bucket depth=0 exhausted: limit")),
        "the bucket becoming exhausted is logged",
      );

      const health = buildHealth({
        state: "connected",
        snapshot: session.snapshot(),
        bucketId: "bucket-root",
        lastError: null,
        pool: pool.health(),
      });
      assert.equal(health.ready, false);
      assert.equal(health.parked, true);
      assert.equal(health.parkedFor, "quota");
      assert.ok(
        health.lastError !== null,
        "zero exits with a spent account is never reported as no failure",
      );
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("the stall threshold is the exported constant, not a local number", () => {
  assert.equal(POOL_NO_PROGRESS_REFILLS, 8);
});

test("a log line never carries a full URL query string", async () => {
  await withRelay({ changes: distinctChanges() }, async (relay) => {
    const session = await connect(relay);
    const lines: string[] = [];
    const pool = makePool(relay, session, {
      retryDelayMs: 10,
      log: (line) => lines.push(line),
      // The real resolver names its endpoints, query string included, in the
      // failure it throws; the log must keep the fact and drop the query.
      lookup: async () => {
        throw new Error("TXT lookup at https://dns.example/resolve?name=1.2.3.4&type=TXT failed");
      },
    });
    try {
      pool.start();
      const parked = await waitFor(pool, (seen) => seen.parked);
      assert.equal(parked.lastError?.reason, "lookup-failed");
      assert.ok(lines.length > 0, "the failure was logged");
      for (const line of lines) {
        assert.equal(
          /\?[^\s"…']/.test(line),
          false,
          `a query string reached the log: ${line}`,
        );
      }
      assert.ok(lines.some((line) => line.includes("lookup-failed")));
      assert.ok(lines.some((line) => line.includes("dns.example")));
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("one live exit leaves no parent for a child bucket, even with depth left", async () => {
  const changes: FakeChange[] = [
    { kind: "changed", ip: "198.51.100.10" },
    { kind: "limit" },
  ];
  await withRelay({ changes }, async (relay) => {
    const session = await connect(relay);
    let opened = 0;
    const pool = makePool(relay, session, {
      target: 3,
      refillBelow: 3,
      max: 4,
      depth: 2,
      retryDelayMs: 10,
      paceCooldownMs: 10,
      // A child bucket is dialled through a ready parent exit. With one live exit
      // there is never a spare one, so this must never be called.
      openSession: async () => {
        opened += 1;
        throw new Error("one live exit leaves no parent to carry a child");
      },
    });
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);

      // The release spends the root's last change; it is refused, so the pool has
      // no exit and no spare parent. It parks as quota instead of inventing a child.
      const lease = await pool.acquire();
      await pool.release(lease.exitId, "good");
      const parked = await waitFor(pool, (seen) => seen.parked);
      assert.equal(parked.parkedFor, "quota");
      assert.equal(opened, 0, "no child bucket was dialled through a dead port");
      assert.equal(relay.stats().changeRequests, 2);
    } finally {
      await pool.close();
      session.stop();
    }
  });
});
