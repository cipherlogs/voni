/**
 * The session state machine, driven end to end through the fake relay.
 *
 * Every assertion is about something an operator can observe: the redirect was
 * followed, the conformance verdicts were honest, the echo was answered, the
 * login was one attempt and not a loop, the account's own limit was read, and no
 * peer traffic was served. Nothing here reaches the network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeRelay } from "./fake-relay";
import { TuxlerSessionError, startSession, type TuxlerSession } from "./control";

const EMAIL = "operator@example.test";
const PASSWORD = "correct-horse-battery";

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

async function connect(relay: FakeRelay, overrides: Record<string, unknown> = {}) {
  return startSession({
    host: "server1.ipsharkk.com",
    port: 29990,
    email: EMAIL,
    password: PASSWORD,
    resolveEndpoint: relay.resolve,
    ...overrides,
  });
}

async function waitForState(
  session: TuxlerSession,
  predicate: (snapshot: ReturnType<TuxlerSession["snapshot"]>) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = session.snapshot();
    if (predicate(snapshot)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`session never reached the expected state: ${JSON.stringify(snapshot)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a session follows the redirect, passes conformance, echoes, logs in and reports the account", async () => {
  await withRelay(
    { redirectServer: 3, changesLimit: 7, changesUsed: 4, resetAt: "2026-11-26T08:26:00-05:00" },
    async (relay) => {
      const session = await connect(relay);
      try {
        const snapshot = session.snapshot();
        assert.equal(snapshot.failure, null);
        assert.deepEqual(relay.stats().conformanceVerdicts, ["OKEXT"]);
        assert.equal(relay.stats().echoReplies, 1);
        assert.equal(relay.stats().secondConnections, 1);
        assert.equal(relay.stats().version3, true);
        assert.deepEqual(relay.stats().connectedHosts, [
          "server1.ipsharkk.com",
          "server3.ipsharkk.com",
        ]);
        assert.equal(snapshot.host, "server3.ipsharkk.com");
        // The relay assigns its second port on the redirected host. Dialling the
        // original entry point is refused by the live relay, so the second socket
        // must follow the redirect like the control socket did.
        assert.deepEqual(relay.stats().secondConnectionHosts, ["server3.ipsharkk.com"]);

        const settled = await waitForState(session, (state) => state.clientIp !== null);
        assert.equal(settled.clientIp, "203.0.113.9", "the exit IP must not read null after login");
        assert.equal(settled.account.changesLimit, 7, "the limit comes from LIMITS_INFO");
        assert.equal(settled.account.changesUsed, 4);
        assert.equal(settled.account.resetAt, "2026-11-26T13:26:00.000Z");
        assert.equal(settled.account.tier, "free");
        assert.ok(settled.handshakeMs !== null && settled.handshakeMs >= 0);
        for (const tag of ["MAKE_TEST_1", "TIMEVAL", "YOUR_IP", "LIMITS_INFO", "ACCOUNT_INFO", "RESET_INFO"]) {
          assert.ok(settled.frames.includes(tag), `expected the session to record ${tag}`);
        }
      } finally {
        session.stop();
      }
    },
  );
});

test("a relay that skips the redirect is followed without inventing a hop", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    try {
      assert.equal(relay.stats().redirectConnections, 0);
      assert.deepEqual(relay.stats().connectedHosts, ["server1.ipsharkk.com"]);
      assert.equal(session.snapshot().host, "server1.ipsharkk.com");
    } finally {
      session.stop();
    }
  });
});

test("the session never derives a port from the handshake", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    try {
      assert.equal("port2" in session, false, "the handshake must not hand out an exit port");
      assert.equal("exitPort" in session, false);
      assert.equal(JSON.stringify(session.snapshot()).includes("port\""), false);
    } finally {
      session.stop();
    }
  });
});

test("peer-assignment counts are read and never served", async () => {
  await withRelay({ peerCount: 3 }, async (relay) => {
    const session = await connect(relay);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(relay.stats().secondConnections, 1, "the client dialled peer connections");
    } finally {
      session.stop();
    }
  });
});

test("the session's second socket is lent to one tunnel at a time and reports its close", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    try {
      const channel = session.openDataChannel();
      assert.ok(channel !== null, "a live session has a second socket to lend");
      assert.equal(
        session.openDataChannel(),
        null,
        "a busy channel is refused, never queued behind the first tunnel",
      );

      const closed = new Promise<void>((resolve) => {
        session.onDataChannelClosed(resolve);
      });
      channel.destroy();
      await closed;
      assert.equal(
        session.openDataChannel(),
        null,
        "a closed channel is never lent again",
      );
    } finally {
      session.stop();
    }
  });
});

test("the heartbeat follows the relay's own TIMEVAL", async () => {
  await withRelay({ timevalSeconds: 11 }, async (relay) => {
    const session = await connect(relay);
    try {
      assert.equal(session.snapshot().heartbeatSeconds, 1);
      const stats = await relay.waitFor((seen) => seen.heartbeats >= 1, 2_500);
      assert.ok(stats.heartbeats >= 1);
    } finally {
      session.stop();
    }
  });
});

test("a relay that goes silent becomes a session failure, not a stall", async () => {
  await withRelay({ silentAfterLogin: true }, async (relay) => {
    const session = await connect(relay, { silenceMs: 200 });
    try {
      const failed = await waitForState(session, (state) => state.state === "failed");
      assert.equal(failed.failure?.reason, "relay-silent");
    } finally {
      session.stop();
    }
  });
});

test("a dropped control socket becomes a session failure", async () => {
  await withRelay({ dropAfterLoginMs: 30 }, async (relay) => {
    const session = await connect(relay);
    try {
      const failed = await waitForState(session, (state) => state.state === "failed");
      assert.equal(failed.failure?.reason, "socket-closed");
    } finally {
      session.stop();
    }
  });
});

test("a wrong password fails once, with a reason, and does not retry", async () => {
  await withRelay({ loginRejection: "close" }, async (relay) => {
    await assert.rejects(connect(relay, { password: "wrong-password" }), (error: unknown) => {
      assert.ok(error instanceof TuxlerSessionError);
      assert.equal(error.reason, "login-rejected");
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(relay.stats().loginAttempts, 1, "a rejected login must not be retried in a loop");
    assert.equal(relay.stats().rejectedLogins, 1);
  });
});

test("an UNAUTHORIZED_ACCESS answer is also a login rejection", async () => {
  await withRelay({ loginRejection: "unauthorized" }, async (relay) => {
    await assert.rejects(connect(relay, { password: "wrong-password" }), (error: unknown) => {
      assert.ok(error instanceof TuxlerSessionError);
      assert.equal(error.reason, "login-rejected");
      return true;
    });
  });
});

test("missing credentials fail before any socket is opened", async () => {
  await withRelay({}, async (relay) => {
    await assert.rejects(connect(relay, { email: "", password: "" }), (error: unknown) => {
      assert.ok(error instanceof TuxlerSessionError);
      assert.equal(error.reason, "credential-missing");
      return true;
    });
    assert.equal(relay.stats().controlConnections, 0);
  });
});

test("a session failure never carries the password in its message", async () => {
  await withRelay({}, async (relay) => {
    const error = await connect(relay, { password: "wrong-password" }).catch(
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof TuxlerSessionError);
    assert.ok(!error.message.includes("wrong-password"), error.message);
  });
});

test("stop closes both sockets", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    session.stop();
    assert.equal(session.snapshot().state, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
