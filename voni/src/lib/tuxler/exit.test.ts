/**
 * One change, one validated US exit, one loopback SOCKS port.
 *
 * Everything here runs against the fake relay: the real session logs in, the real
 * change command is sent, the real validator decides, and a real SOCKS client walks
 * through the listener to an address-echo service. The two things this file exists
 * to prove are that the served port is the one the change reply named — never the
 * handshake's derived port — and that a rejected reply is served nothing at all.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { FakeRelay, type FakeChange } from "./fake-relay";
import { startSession, type TuxlerSession } from "./control";
import { ExitRejectedError, openUsExit, type TuxlerExit } from "./exit";
import { type AsnRecord } from "./validate";

const EMAIL = "operator@example.test";
const PASSWORD = "correct-horse-battery";
const EXIT_IP = "198.51.100.7";

const CONSUMER: AsnRecord = {
  asn: 7018,
  prefix: "198.51.100.0/24",
  country: "US",
  name: "ATT-INTERNET4 - AT&T Services, Inc.",
};

const HOSTING: AsnRecord = {
  asn: 16509,
  prefix: "198.51.100.0/24",
  country: "US",
  name: "AMAZON-02 - Amazon.com, Inc.",
};

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

interface OpenOptions {
  lookup?: (ip: string) => Promise<AsnRecord>;
  changeTimeoutMs?: number;
}

async function obtain(relay: FakeRelay, session: TuxlerSession, options: OpenOptions = {}) {
  return openUsExit({
    session,
    relayHost: "server1.ipsharkk.com",
    resolveEndpoint: relay.resolve,
    lookup: options.lookup ?? (async () => CONSUMER),
    changeTimeoutMs: options.changeTimeoutMs,
  });
}

/**
 * A buffered SOCKS5 client. Reads are taken from one accumulating buffer, because a
 * grant and the first application bytes routinely arrive in the same TCP segment.
 */
class SocksClient {
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
    socket.on("error", () => {
      this.closed = true;
      this.wake();
    });
  }

  static async open(port: number): Promise<SocksClient> {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    await once(socket, "connect");
    return new SocksClient(socket);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private park(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(1, ms));
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async take(size: number, timeoutMs = 2_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length < size) {
      if (this.closed) throw new Error("the socket closed before enough bytes arrived");
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${size} bytes`);
      await this.park(Math.min(20, deadline - Date.now()));
    }
    const taken = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return taken;
  }

  async drain(timeoutMs = 400): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await this.park(Math.min(20, deadline - Date.now()));
    }
    const text = this.buffer.toString("latin1");
    this.buffer = Buffer.alloc(0);
    return text;
  }

  greet(): void {
    this.socket.write(Buffer.from([0x05, 0x01, 0x00]));
  }

  connect(host: string, port: number): void {
    const name = Buffer.from(host, "latin1");
    this.socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
        name,
        Buffer.from([port >> 8, port & 0xff]),
      ]),
    );
  }

  write(text: string): void {
    this.socket.write(Buffer.from(text, "latin1"));
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Greet, CONNECT to a hostname, and return the SOCKS reply code. */
async function socksConnect(
  port: number,
  host: string,
  targetPort: number,
): Promise<{ rep: number; client: SocksClient }> {
  const client = await SocksClient.open(port);
  client.greet();
  const greeting = await client.take(2);
  assert.deepEqual([...greeting], [0x05, 0x00]);
  client.connect(host, targetPort);
  const reply = await client.take(10);
  return { rep: reply[1], client };
}

/** Ask the address-echo service who it sees; returns the address in the body. */
async function addressSeenBy(exit: Pick<TuxlerExit, "localPort">): Promise<string> {
  const { rep, client } = await socksConnect(exit.localPort, "echo.example.test", 80);
  assert.equal(rep, 0x00, "the echo service must be reachable through the exit");
  const body = await client.drain();
  client.destroy();
  const match = /ip=([0-9.]+)/.exec(body);
  assert.ok(match, `the echo body must name an address: ${JSON.stringify(body)}`);
  return match[1];
}

test("one change yields a US exit served on the reply's own port, and the echo reports it twice", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    try {
      const exit = await obtain(relay, session);
      try {
        const stats = relay.stats();
        assert.equal(stats.changeRequests, 1, "one change, not a retry loop");
        assert.equal(exit.ip, EXIT_IP);
        assert.equal(exit.port, stats.exitPorts[0], "the served port is the change reply's port");
        assert.notEqual(exit.port, stats.secondPort + 1, "never the handshake-derived port");
        assert.equal(exit.countryIso, "US");
        assert.equal(exit.asn.asn, 7018);
        assert.match(exit.socksUrl, /^socks5h:\/\/127\.0\.0\.1:\d+$/);

        const first = await addressSeenBy(exit);
        const second = await addressSeenBy(exit);
        assert.equal(first, EXIT_IP, "the echo must see the exit, not the host");
        assert.equal(second, first, "a second request leaves from the same address");

        const tunneled = relay.stats();
        assert.equal(tunneled.addressEchoRequests, 2);
        assert.deepEqual(tunneled.tunnelPorts, [exit.port, exit.port]);
        assert.equal(tunneled.tunnelTargets[0].host, "echo.example.test");
      } finally {
        await exit.close();
      }
    } finally {
      session.stop();
    }
  });
});

test("a hostname destination resolves through the relay, and a refusal is reported", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    try {
      const exit = await obtain(relay, session);
      try {
        const ok = await socksConnect(exit.localPort, "chatty.example.test", 7);
        assert.equal(ok.rep, 0x00);
        ok.client.write("ping");
        const echoed = await ok.client.take(4);
        assert.equal(echoed.toString("latin1"), "ping");
        ok.client.destroy();

        const refused = await socksConnect(exit.localPort, "refused.example.test", 9);
        assert.equal(refused.rep, 0x05, "a refused destination is reported, not silently closed");
        refused.client.destroy();

        assert.deepEqual(
          relay.stats().tunnelTargets.map((target) => target.host),
          ["chatty.example.test", "refused.example.test"],
        );
      } finally {
        await exit.close();
      }
    } finally {
      session.stop();
    }
  });
});

test("a non-US reply is rejected, and nothing is served", async () => {
  await withRelay(
    { changes: [{ kind: "changed", ip: EXIT_IP, countryIso: "DE", country: "Germany", city: "Berlin" }] },
    async (relay) => {
      const session = await connect(relay);
      try {
        await assert.rejects(obtain(relay, session), (error: unknown) => {
          assert.ok(error instanceof ExitRejectedError);
          assert.equal(error.reason, "not-us");
          return true;
        });
        assert.equal(relay.stats().tunnelConnections, 0, "a rejected exit is never dialled");
      } finally {
        session.stop();
      }
    },
  );
});

test("a reply that names no country is accepted when the registry says US", async () => {
  await withRelay(
    { changes: [{ kind: "changed", ip: EXIT_IP, countryIso: "" }] },
    async (relay) => {
      const session = await connect(relay);
      const lines: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        const exit = await obtain(relay, session);
        try {
          assert.equal(exit.countryIso, "US", "the registry's country stands in for the silent reply");
          assert.equal(exit.asn.country, "US");
          assert.ok(
            lines.some((line) =>
              /^change reply elements=\[[a-z,]+\] country=registry:US$/.test(line),
            ),
            `the reply's element names must be logged: ${JSON.stringify(lines)}`,
          );
        } finally {
          await exit.close();
        }
      } finally {
        console.log = original;
        session.stop();
      }
    },
  );
});

test("a reply that names no country is rejected when the registry places the exit elsewhere", async () => {
  await withRelay(
    { changes: [{ kind: "changed", ip: EXIT_IP, countryIso: "" }] },
    async (relay) => {
      const session = await connect(relay);
      try {
        await assert.rejects(
          obtain(relay, session, { lookup: async () => ({ ...CONSUMER, country: "GH" }) }),
          (error: unknown) => {
            assert.ok(error instanceof ExitRejectedError);
            assert.equal(error.reason, "not-us");
            assert.match(error.message, /registry places 198\.51\.100\.7 in GH/);
            return true;
          },
        );
        assert.equal(relay.stats().tunnelConnections, 0, "a rejected exit is never dialled");
      } finally {
        session.stop();
      }
    },
  );
});

test("a US address in a hosting ASN is rejected", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    try {
      await assert.rejects(obtain(relay, session, { lookup: async () => HOSTING }), (error: unknown) => {
        assert.ok(error instanceof ExitRejectedError);
        assert.equal(error.reason, "hosting");
        return true;
      });
      assert.equal(relay.stats().tunnelConnections, 0);
    } finally {
      session.stop();
    }
  });
});

test("a failed ASN lookup fails closed", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    try {
      await assert.rejects(
        obtain(relay, session, {
          lookup: async () => {
            throw new Error("queryTxt ENOTFOUND");
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ExitRejectedError);
          assert.equal(error.reason, "lookup-failed");
          return true;
        },
      );
      assert.equal(relay.stats().tunnelConnections, 0);
    } finally {
      session.stop();
    }
  });
});

test("every reply that is not an exit is classified and served nothing", async () => {
  const cases: Array<[FakeChange, string]> = [
    [{ kind: "limit" }, "limit"],
    [{ kind: "not-available" }, "not-available"],
    [{ kind: "overloaded" }, "overloaded"],
    [{ kind: "not-entitled" }, "not-entitled"],
    [{ kind: "no-change" }, "no-change"],
    [{ kind: "exit-unavailable" }, "exit-unavailable"],
    [{ kind: "incomplete" }, "incomplete"],
  ];
  for (const [change, reason] of cases) {
    await withRelay({ changes: [change] }, async (relay) => {
      const session = await connect(relay);
      try {
        await assert.rejects(obtain(relay, session), (error: unknown) => {
          assert.ok(error instanceof ExitRejectedError);
          assert.equal(error.reason, reason);
          return true;
        });
        const stats = relay.stats();
        assert.equal(stats.tunnelConnections, 0, `${reason}: nothing may be served`);
        assert.deepEqual(stats.tunnelPorts, [], `${reason}: no port may be dialled`);
      } finally {
        session.stop();
      }
    });
  }
});

test("a success without a port never falls back to the handshake port", async () => {
  await withRelay({ changes: [{ kind: "incomplete" }] }, async (relay) => {
    const session = await connect(relay);
    try {
      const handshakePort = relay.stats().secondPort;
      await assert.rejects(obtain(relay, session), (error: unknown) => {
        assert.ok(error instanceof ExitRejectedError);
        assert.equal(error.reason, "incomplete");
        return true;
      });
      const stats = relay.stats();
      assert.equal(stats.tunnelPorts.includes(handshakePort), false);
      assert.equal(stats.tunnelPorts.includes(handshakePort + 1), false);
      assert.deepEqual(stats.tunnelPorts, []);
    } finally {
      session.stop();
    }
  });
});

test("a relay that goes silent after the change is unhealthy, not out of exits", async () => {
  await withRelay({ changes: [{ kind: "silent" }] }, async (relay) => {
    const session = await connect(relay);
    try {
      await assert.rejects(obtain(relay, session, { changeTimeoutMs: 200 }), (error: unknown) => {
        assert.ok(error instanceof ExitRejectedError);
        assert.equal(error.reason, "relay-silent");
        return true;
      });
      assert.equal(session.snapshot().state, "failed");
      assert.equal(session.snapshot().failure?.reason, "relay-silent");
    } finally {
      session.stop();
    }
  });
});

test("closing the exit closes its listener", async () => {
  await withRelay({}, async (relay) => {
    const session = await connect(relay);
    try {
      const exit = await obtain(relay, session);
      await exit.close();
      assert.equal(exit.state, "dead");
      const socket = net.connect({ host: "127.0.0.1", port: exit.localPort });
      await assert.rejects(once(socket, "connect"));
      socket.destroy();
    } finally {
      session.stop();
    }
  });
});
