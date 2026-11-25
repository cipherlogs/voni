/**
 * The refill budget: a bucket tree, paced changes, and silence that reconnects.
 *
 * Everything runs against the fake relay, so every number asserted is the relay's
 * own count on the wire. The three promises this file keeps are the ticket's:
 *
 * - an exhausted root bucket opens a child through a ready exit, and refills
 *   continue with the same acquire/release contract;
 * - depth is a refill *budget*, so reaching it fails as "quota spent" instead of
 *   hanging, and the pool never holds more exits than its target;
 * - silence is a reconnect, never "no US exit", and changes are paced so a
 *   session that has sent five in a row waits before the sixth.
 *
 * Multi-hop tunnels are proved by asking the address-echo service who it sees:
 * a request through a child exit must leave from the child's own address, even
 * though that exit is only reachable through its parent.
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
const EXIT_C = "198.51.100.12";

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

test("an exhausted root bucket opens a child through a ready exit, and refills resume", async () => {
  const changes: FakeChange[] = [
    { kind: "changed", ip: EXIT_A },
    { kind: "limit" },
    { kind: "changed", ip: EXIT_C },
    { kind: "changed", ip: EXIT_C },
  ];
  await withRelay({ changes, tunnelHosts: TUNNELS }, async (relay) => {
    const session = await connect(relay);
    const pool = makePool(relay, session, {
      target: 2,
      refillBelow: 2,
      max: 4,
      depth: POOL_DEPTH,
      openSession: childSessions(relay),
    });
    try {
      pool.start();
      const filled = await waitFor(pool, (seen) => seen.ready === 2);

      assert.equal(relay.stats().changeRequests, 3, "two changes on the root, one on the child");
      assert.equal(filled.buckets.length, 2, "the root and the child are both reported");

      const [root, child] = filled.buckets;
      assert.equal(root.depth, 0);
      assert.equal(child.depth, 1);
      assert.equal(child.parentId, root.clientIpHash, "the child names the bucket it came through");
      assert.notEqual(root.clientIpHash, child.clientIpHash, "two addresses, two buckets");
      assert.equal(root.clientIpHash, bucketId(EMAIL, "203.0.113.9"), "the root is the runner's address");
      assert.equal(child.clientIpHash, bucketId(EMAIL, EXIT_A), "the child is the parent exit's address");
      assert.equal(root.used, 3, "the root keeps the account's own usage");
      assert.equal(child.used, 0, "the child starts with a fresh allowance");
      assert.equal(root.limit, 10);
      assert.equal(child.limit, 10);
      assert.ok(filled.total <= 2 && filled.ready <= 2, "depth is a budget, not concurrency");

      // The acquire contract is unchanged: two leases, then the child refills.
      const first = await pool.acquire();
      const second = await pool.acquire();
      assert.equal(pool.snapshot().ready, 0);
      const refilled = await waitFor(pool, (seen) => seen.ready === 2);
      assert.equal(relay.stats().changeRequests, 5, "refills come from the child, not the spent root");
      assert.equal(refilled.buckets.length, 2, "no second child was needed");
      assert.ok(refilled.total <= refilled.max);

      await pool.release(first.exitId, "good");
      await pool.release(second.exitId, "good");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("depth is the refill budget: at the configured depth refills fail as quota spent", async () => {
  const changes: FakeChange[] = [
    { kind: "changed", ip: EXIT_A },
    { kind: "limit" },
    { kind: "changed", ip: EXIT_C },
    { kind: "limit" },
    { kind: "limit" },
  ];
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
      const filled = await waitFor(pool, (seen) => seen.buckets.length === 3);
      assert.equal(relay.stats().changeRequests, 5, "the tree stopped spending at depth two");

      assert.deepEqual(
        filled.buckets.map((bucket) => bucket.depth),
        [0, 1, 2],
        "the root plus one child per level",
      );
      assert.equal(
        new Set(filled.buckets.map((bucket) => bucket.clientIpHash)).size,
        3,
        "every bucket keeps its own address",
      );
      assert.deepEqual(
        filled.buckets.map((bucket) => bucket.used),
        [3, 0, 0],
        "each bucket reports its own usage",
      );

      const leases = [];
      for (let index = 0; index < 2; index += 1) leases.push(await pool.acquire());
      await assert.rejects(pool.acquire({ waitMs: 300 }), (error: unknown) => {
        assert.ok(error instanceof PoolUnavailableError);
        assert.equal(error.reason, "quota-spent", "depth exhaustion is not a supply failure");
        return true;
      });
      assert.equal(relay.stats().changeRequests, 5, "a refusal at depth spends nothing");
      assert.ok(pool.snapshot().total <= 4, "and nothing was opened behind the depth");

      for (const lease of leases) await pool.release(lease.exitId, "good");
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
      const healed = await waitFor(pool, (seen) => seen.ready === 2);
      const stats = relay.stats();
      assert.equal(stats.controlConnections, 2, "the silent session was closed and replaced");
      assert.equal(stats.loginAttempts, 2);
      assert.equal(healed.reconnects, 1);
      assert.equal(healed.lastReconnect?.reason, silenceReason);
      assert.equal(healed.lastReconnect?.depth, 0);
      assert.equal(healed.lastError, null, "a reconnect that worked is not an error");

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

  await withRelay({ changes: distinctChanges() }, async (relay) => {
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
      await waitFor(pool, (seen) => seen.ready === 5);
      assert.equal(relay.stats().changeRequests, 5, "the fill spends exactly the burst");

      const leases = [];
      for (let index = 0; index < 5; index += 1) leases.push(await pool.acquire());
      const startedWaiting = Date.now();
      await pause(150);
      assert.equal(relay.stats().changeRequests, 5, "the sixth change waits instead of bursting");

      const refilled = await waitFor(pool, (seen) => seen.total === 8, 6_000);
      const waited = Date.now() - startedWaiting;
      assert.equal(relay.stats().changeRequests, 8, "three refills, and no more than the maximum");
      assert.ok(waited >= cooldown * 0.75, `the sixth change came after the cooldown (${waited} ms)`);
      assert.ok(refilled.ready <= refilled.target);

      for (const lease of leases) await pool.release(lease.exitId, "good");
    } finally {
      await pool.close();
      session.stop();
    }
  });
});

test("a child exit carries its payload through its parent, and each hop reports its own address", async () => {
  const changes: FakeChange[] = [
    { kind: "changed", ip: EXIT_A },
    { kind: "changed", ip: EXIT_B },
    { kind: "limit" },
    { kind: "changed", ip: EXIT_C },
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
      const filled = await waitFor(pool, (seen) => seen.ready === 3);
      assert.equal(relay.stats().changeRequests, 4);

      const parent = filled.exits.find((exit) => exit.ip === EXIT_A);
      const child = filled.exits.find((exit) => exit.ip === EXIT_C);
      assert.ok(parent, "the parent exit is served");
      assert.ok(child, "the child exit is served");

      assert.equal(await addressSeenBy(parent.localPort), EXIT_A);
      assert.equal(await addressSeenBy(child.localPort), EXIT_C);

      const stats = relay.stats();
      assert.equal(stats.addressEchoRequests, 2);
      assert.ok(
        stats.tunnelTargets.some((target) => target.port === child.port),
        "the child's port was reached through its parent",
      );
      assert.ok(
        stats.tunnelTargets.filter((target) => target.host === "echo.example.test").length === 2,
        "both requests carried their own destination",
      );
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
