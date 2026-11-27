/**
 * The refill budget and pacing, with the one live exit Tuxler allows.
 *
 * Everything runs against the fake relay, so every number asserted is the relay's
 * own count on the wire. The promises this file keeps:
 *
 * - a bucket's changes are metered separately, but with one live exit there is
 *   never a spare parent to carry a child bucket, so a spent root parks as quota
 *   instead of growing a tree that cannot be reached;
 * - depth stays a configured budget and is reported, never silently spent;
 * - silence is a reconnect, never "no US exit", and changes are paced so a
 *   session that has sent five in a row waits before the sixth.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { FakeRelay, type FakeChange } from "./fake-relay";
import { startSession, type TuxlerSession } from "./control";
import {
  POOL_DEPTH,
  POOL_PACE_BURST,
  POOL_SILENCE_MS,
  PoolUnavailableError,
  createExitPool,
  type BucketLink,
  type ExitPool,
  type PoolSession,
  type PoolSnapshot,
} from "./pool";
import { buildHealth, bucketId } from "./health";
import type { AsnRecord } from "./validate";

const EMAIL = "operator@example.test";
const PASSWORD = "correct-horse-battery";

/** The relay's own addresses, distinct so "two buckets" cannot pass on ports alone. */
const EXIT_A = "198.51.100.10";
const EXIT_B = "198.51.100.11";

const CONSUMER: AsnRecord = {
  asn: 7018,
  prefix: "198.51.100.0/24",
  country: "US",
  name: "ATT-INTERNET4 - AT&T Services, Inc.",
};

/** A child session has to reach the relay *through* the parent exit. */
const TUNNELS = {
  "echo.example.test": "address-echo" as const,
  "server1.ipsharkk.com": "forward" as const,
  // A nested hop's header names the address the client resolved, not the name.
  "127.0.0.1": "forward" as const,
};

function distinctChanges(count = 14): FakeChange[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "changed" as const,
    ip: `198.51.100.${10 + index}`,
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

function sessionOptions(
  relay: FakeRelay,
  overrides: Partial<Parameters<typeof startSession>[0]> = {},
): Parameters<typeof startSession>[0] {
  return {
    host: "server1.ipsharkk.com",
    port: 29990,
    email: EMAIL,
    password: PASSWORD,
    resolveEndpoint: relay.resolve,
    stageTimeoutMs: 2_000,
    ...overrides,
  };
}

async function connect(relay: FakeRelay): Promise<TuxlerSession> {
  return startSession(sessionOptions(relay));
}

/**
 * The production factory in miniature: a root replacement dials the relay
 * directly, and a child dials it through the exit it was opened over.
 */
function childSessions(relay: FakeRelay) {
  return async (link: BucketLink | null): Promise<PoolSession> => {
    if (link === null) return startSession(sessionOptions(relay));
    return startSession(
      sessionOptions(relay, {
        transport: (host) => ({
          label: `via ${link.exitIp}`,
          openControl: () => link.dial({ host, port: 29990 }),
          openSecond: (port) => link.dial({ host, port }),
        }),
      }),
    );
  };
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
    bucketId: (clientIp) => (clientIp === null ? null : bucketId(EMAIL, clientIp)),
    retryDelayMs: 50,
    paceCooldownMs: 50,
    changeTimeoutMs: 2_000,
    resetPollMs: 25,
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

/** One SOCKS5 CONNECT to a hostname; returns the reply code and everything read. */
async function socksRequest(
  port: number,
  host: string,
  targetPort: number,
  timeoutMs = 2_000,
): Promise<{ rep: number; body: string }> {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  await once(socket, "connect");
  let buffer = Buffer.alloc(0);
  let closed = false;
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => {
    closed = true;
  });

  const take = async (size: number): Promise<Buffer> => {
    const deadline = Date.now() + timeoutMs;
    while (buffer.length < size) {
      if (closed) throw new Error("the socket closed before enough bytes arrived");
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${size} bytes`);
      await pause(5);
    }
    const taken = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return taken;
  };

  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual([...(await take(2))], [0x05, 0x00]);
  const name = Buffer.from(host, "latin1");
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
      name,
      Buffer.from([targetPort >> 8, targetPort & 0xff]),
    ]),
  );
  const reply = await take(10);
  const deadline = Date.now() + timeoutMs;
  while (!closed && Date.now() < deadline) await pause(5);
  const body = buffer.toString("latin1");
  socket.destroy();
  return { rep: reply[1], body };
}

/** Ask the address-echo service who it sees through this exit's SOCKS port. */
async function addressSeenBy(localPort: number): Promise<string> {
  const { rep, body } = await socksRequest(localPort, "echo.example.test", 80);
  assert.equal(rep, 0x00, "the echo service must be reachable through the exit");
  const match = /ip=([0-9.]+)/.exec(body);
  assert.ok(match, `the echo body must name an address: ${JSON.stringify(body)}`);
  return match[1];
}

test("an exhausted root parks as quota: one live exit leaves no parent for a child", async () => {
  const changes: FakeChange[] = [
    { kind: "changed", ip: EXIT_A },
    { kind: "limit" },
  ];
  await withRelay({ changes, tunnelHosts: TUNNELS }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, {
      target: 3,
      refillBelow: 3,
      max: 4,
      depth: POOL_DEPTH,
      openSession: childSessions(relay),
    });
    try {
      pool.start();
      const filled = await waitFor(pool, (seen) => seen.ready === 1);

      assert.equal(relay.stats().changeRequests, 1, "one live exit, one change");
      assert.equal(filled.buckets.length, 1, "only the root bucket exists");
      assert.equal(filled.buckets[0].depth, 0);
      assert.equal(
        filled.buckets[0].clientIpHash,
        bucketId(EMAIL, "203.0.113.9"),
        "the root is the runner's address",
      );
      assert.equal(filled.buckets[0].used, 3, "the root keeps the account's own usage");
      assert.ok(filled.total <= 1 && filled.ready <= 1, "depth is a budget, not concurrency");

      // The release retires the one exit and spends the root's next change. It is
      // refused, and with no spare ready exit there is no parent to open a child
      // through: the pool must say "quota spent", not invent a bucket.
      const lease = await pool.acquire();
      await pool.release(lease.exitId, "good");
      const parked = await waitFor(pool, (seen) => seen.parked);
      assert.equal(parked.parkedFor, "quota");
      assert.equal(parked.buckets.length, 1, "no child bucket was opened through a dead port");
      assert.equal(relay.stats().changeRequests, 2);
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a configured depth is reported but one live exit cannot spend it", async () => {
  const changes: FakeChange[] = [{ kind: "limit" }];
  await withRelay({ changes, tunnelHosts: TUNNELS }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, {
      target: 3,
      refillBelow: 3,
      max: 4,
      depth: 2,
      openSession: childSessions(relay),
    });
    try {
      pool.start();
      const parked = await waitFor(pool, (seen) => seen.parked);
      assert.equal(parked.depth, 2, "the depth budget is still reported");
      assert.equal(parked.parkedFor, "quota", "a spent root with no child reachable is quota, not silence");
      assert.deepEqual(parked.buckets.map((bucket) => bucket.depth), [0], "the root alone");
      assert.equal(relay.stats().changeRequests, 1, "a refusal at the root spends nothing more");

      await assert.rejects(pool.acquire({ waitMs: 300 }), (error: unknown) => {
        assert.ok(error instanceof PoolUnavailableError);
        assert.equal(error.reason, "quota-spent", "depth exhaustion is not a supply failure");
        return true;
      });
      assert.ok(pool.snapshot().total <= 1, "and nothing was opened behind the depth");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a silent session is reconnected, and health says reconnect rather than no US exit", async () => {
  const silenceReason = "relay-silent";
  const changes: FakeChange[] = [{ kind: "changed", ip: EXIT_A }, { kind: "silent" }, { kind: "changed", ip: EXIT_B }];
  await withRelay({ changes, tunnelHosts: TUNNELS }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, {
      target: 2,
      refillBelow: 2,
      max: 4,
      depth: POOL_DEPTH,
      openSession: childSessions(relay),
      changeTimeoutMs: 150,
    });
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);
      assert.equal(relay.stats().changeRequests, 1, "one live exit from the first change");

      // Force the second change: releasing good retires the exit and refills, and
      // that change is the one the relay answers with silence.
      const lease = await pool.acquire();
      await pool.release(lease.exitId, "good");
      const healed = await waitFor(pool, (seen) => seen.ready === 1 && seen.reconnects === 1);
      const stats = relay.stats();
      assert.equal(stats.controlConnections, 2, "the silent session was closed and replaced");
      assert.equal(stats.loginAttempts, 2);
      assert.equal(healed.reconnects, 1);
      assert.equal(healed.lastReconnect?.reason, silenceReason);
      assert.equal(healed.lastReconnect?.depth, 0);
      assert.equal(healed.lastError, null, "a reconnect that worked is not an error");
      assert.equal(relay.stats().changeRequests, 3, "the retry after the reconnect succeeded");
      assert.equal(healed.exits[0].ip, EXIT_B, "the replacement change named a fresh exit");

      const health = buildHealth({
        state: "connected",
        snapshot: session.snapshot(),
        bucketId: healed.buckets[0].clientIpHash,
        lastError: healed.lastError,
        pool: pool.health(),
      });
      assert.equal(health.reconnects, 1, "health reports the reconnect");
      assert.notEqual(health.lastError?.reason, "no-us-exit", "silence is never a supply failure");
    } finally {
      await pool.close();
      session.stop();
    }
  });

  // The other side of the assertion: thin supply really does say `no-us-exit`,
  // so the two reasons are distinct on the wire, not just in wording.
  await withRelay({ changes: [{ kind: "not-available" }] }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, { target: 2, refillBelow: 2, depth: 0 });
    try {
      pool.start();
      await assert.rejects(pool.acquire({ waitMs: 400 }), (error: unknown) => {
        assert.ok(error instanceof PoolUnavailableError);
        assert.equal(error.reason, "no-us-exit");
        assert.notEqual(error.reason, silenceReason);
        return true;
      });
      assert.equal(pool.snapshot().reconnects, 0);
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a session sends at most five changes in a row, then waits out the cooldown", async () => {
  assert.equal(POOL_PACE_BURST, 5);
  assert.equal(POOL_SILENCE_MS, 20_000);

  await withRelay({ changes: distinctChanges(12) }, async (relay) => {
    const session = await connect(relay);
    const cooldown = 400;
    const pool = makePool(relay, session, {
      target: 5,
      refillBelow: 5,
      max: 8,
      depth: 0,
      paceCooldownMs: cooldown,
    });
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);
      assert.equal(relay.stats().changeRequests, 1, "the fill spends the first change");

      // Each good release retires the exit and spends one change on its
      // replacement, so four releases reach the burst's fifth change.
      for (let index = 0; index < 4; index += 1) {
        const lease = await pool.acquire();
        await pool.release(lease.exitId, "good");
        await waitFor(pool, (seen) => seen.ready === 1);
      }
      assert.equal(relay.stats().changeRequests, POOL_PACE_BURST, "five changes in a row");

      const lease = await pool.acquire();
      const startedWaiting = Date.now();
      await pool.release(lease.exitId, "good");
      await pause(150);
      assert.equal(
        relay.stats().changeRequests,
        5,
        "the sixth change waits instead of bursting",
      );

      const refilled = await waitFor(pool, (seen) => seen.ready === 1, 6_000);
      const waited = Date.now() - startedWaiting;
      assert.equal(relay.stats().changeRequests, 6, "one replacement after the cooldown");
      assert.ok(waited >= cooldown * 0.75, `the sixth change came after the cooldown (${waited} ms)`);
      assert.equal(refilled.total, 1);
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("the one live exit carries its payload and the relay reports its own address", async () => {
  const changes: FakeChange[] = [{ kind: "changed", ip: EXIT_A }];
  await withRelay({ changes, tunnelHosts: TUNNELS }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, {
      target: 3,
      refillBelow: 3,
      max: 4,
      depth: POOL_DEPTH,
      openSession: childSessions(relay),
    });
    try {
      pool.start();
      const filled = await waitFor(pool, (seen) => seen.ready === 1);
      assert.equal(relay.stats().changeRequests, 1);

      const exit = filled.exits[0];
      assert.ok(exit, "the one live exit is served");
      assert.equal(await addressSeenBy(exit.localPort), EXIT_A, "the request left from the exit");

      const stats = relay.stats();
      assert.equal(stats.addressEchoRequests, 1);
      assert.ok(
        stats.tunnelTargets.some(
          (target) => target.host === "echo.example.test" && target.port === 80,
        ),
        "the request carried its own destination through the exit",
      );
      assert.equal(filled.buckets.length, 1, "one live exit means one bucket, no nested hop");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a reset restores the exhausted root bucket without a restart", async () => {
  const changes: FakeChange[] = [
    { kind: "changed", ip: EXIT_A },
    { kind: "limit" },
    { kind: "changed", ip: EXIT_B },
  ];
  await withRelay({ changes }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, {
      target: 1,
      refillBelow: 1,
      max: 2,
      depth: 0,
    });
    try {
      pool.start();
      await waitFor(pool, (seen) => seen.ready === 1);

      const lease = await pool.acquire();
      await pool.release(lease.exitId, "failed");
      await pool.release(lease.exitId, "failed");
      await waitFor(pool, (seen) => seen.lastError !== null && seen.ready === 0);
      assert.equal(relay.stats().changeRequests, 2, "the root's last change was refused");

      await assert.rejects(pool.acquire({ waitMs: 300 }), (error: unknown) => {
        assert.ok(error instanceof PoolUnavailableError);
        assert.equal(error.reason, "quota-spent");
        return true;
      });

      relay.pushReset("2026-11-27T08:26:00-05:00", 0);
      const restored = await waitFor(pool, (seen) => seen.ready === 1 && seen.lastError === null);
      assert.equal(restored.buckets[0].used, 0, "the reset's own usage is reported");
      assert.equal(restored.buckets[0].resetAt, "2026-11-27T13:26:00.000Z");

      const again = await pool.acquire();
      assert.equal(again.ip, EXIT_B, "refills resumed on the restored root bucket");
      assert.equal(relay.stats().changeRequests, 3);
      await pool.release(again.exitId, "good");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});
