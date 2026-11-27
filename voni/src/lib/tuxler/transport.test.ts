/**
 * The socket layer between the client and the relay.
 *
 * Two properties are load-bearing and both are proved here: only the outbound
 * direction of an exit tunnel is XOR-0x73 masked (inbound bytes arrive raw), and a
 * nested hop opens the relay's connection with a `<h>host<p>port</p></h>` header.
 * The endpoint resolver is the one seam a test uses in place of DNS — a test-only
 * mapping of `serverN.ipsharkk.com` to loopback, never a behaviour switch.
 *
 * The exit tunnel has exactly one framing and exactly one acceptance rule: the
 * masked destination header is written when the tunnel opens, and a host is accepted
 * if it survives a short grace window without hanging up. The relay never speaks
 * before the payload arrives, so an open and silent socket is the normal case; only
 * an immediate hang-up rejects a host.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { Duplex } from "node:stream";
import {
  directTransport,
  exitTunnelDialer,
  exitTunnelFrame,
  forgetAcceptedTunnelVariant,
  tunnelTransport,
  xor73,
  type RelayEndpoint,
} from "./transport";

/**
 * A tunnel stand-in: the dialer wraps it, and the test decides what the relay
 * says. `autoReply` answers the first header write, which is how the relay's first
 * bytes are observed without a loopback socket.
 */
class FakeTunnel extends Duplex {
  readonly written: Buffer[] = [];
  private replied = false;
  constructor(private readonly autoReply: Buffer | null = null) {
    super();
  }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    if (this.autoReply !== null && !this.replied) {
      this.replied = true;
      this.push(this.autoReply);
    }
    callback();
  }
  reply(bytes: Buffer): void {
    this.push(bytes);
  }
}

/** Poll until the condition holds; log lines arrive on the tunnel's own schedule. */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let already-scheduled socket traffic land before asserting that nothing else did. */
function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Listener {
  port: number;
  connections: number;
  sockets: net.Socket[];
  received: () => Buffer;
  waitForBytes: (count: number, timeoutMs?: number) => Promise<Buffer>;
  close: () => Promise<void>;
}

async function startListener(
  options: { onConnect?: (socket: net.Socket) => void } = {},
): Promise<Listener> {
  const sockets: net.Socket[] = [];
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    options.onConnect?.(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  const received = () => Buffer.concat(chunks);
  return {
    port: address.port,
    get connections() {
      return sockets.length;
    },
    sockets,
    received,
    async waitForBytes(count, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (received().length >= count) return received();
        if (Date.now() > deadline) throw new Error("listener saw too few bytes");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Read exactly `count` bytes off a duplex, failing instead of hanging forever. */
function readBytes(stream: Duplex, count: number, timeoutMs = 2_000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off("data", onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`stream yielded ${total} of ${count} bytes`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      chunks.push(Buffer.from(chunk));
      total += chunk.length;
      if (total >= count) {
        cleanup();
        resolve(Buffer.concat(chunks));
      }
    };
    stream.on("data", onData);
  });
}

/**
 * A pass-through over a loopback socket that records every write synchronously, so
 * a test can assert what the dialer had already sent at the instant it resolved.
 */
class RecordingSocket extends Duplex {
  readonly writes: Buffer[] = [];
  constructor(private readonly inner: net.Socket) {
    super();
    inner.on("data", (chunk: Buffer) => this.push(chunk));
    inner.on("end", () => this.push(null));
    inner.on("close", () => this.destroy());
    inner.on("error", (error: Error) => this.destroy(error));
  }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk));
    this.inner.write(chunk, callback);
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inner.destroy();
    callback(error);
  }
}

/** Dial a loopback endpoint and hand back a socket that records its own writes. */
async function dialRecording(endpoint: RelayEndpoint): Promise<RecordingSocket> {
  const socket = net.connect({ host: endpoint.host, port: endpoint.port });
  socket.setNoDelay(true);
  await once(socket, "connect");
  return new RecordingSocket(socket);
}

/** Dial a loopback endpoint without recording; the tunnel's own mask is the subject. */
async function dialQuietly(endpoint: RelayEndpoint): Promise<net.Socket> {
  const socket = net.connect({ host: endpoint.host, port: endpoint.port });
  socket.setNoDelay(true);
  await once(socket, "connect");
  return socket;
}

/** The masked header a dial for `target` must write before any payload. */
function headerFor(target: RelayEndpoint): Buffer {
  return xor73(Buffer.from(`<h>${target.host}<p>${target.port}</p></h>`, "latin1"));
}

const EXAMPLE: RelayEndpoint = { host: "example.com", port: 443 };

test("xor73 masks every byte with 0x73", () => {
  const masked = xor73(Buffer.from("abc", "latin1"));
  assert.deepEqual([...masked], [0x61 ^ 0x73, 0x62 ^ 0x73, 0x63 ^ 0x73]);
  assert.deepEqual([...xor73(masked)], [0x61, 0x62, 0x63]);
});

test("exitTunnelFrame is the masked destination header", () => {
  assert.deepEqual(exitTunnelFrame(EXAMPLE), headerFor(EXAMPLE));
  assert.equal(
    xor73(exitTunnelFrame(EXAMPLE)).toString("latin1"),
    "<h>example.com<p>443</p></h>",
  );
});

test("a direct transport dials the endpoint the resolver names", async () => {
  const server = await startListener();
  try {
    const transport = directTransport({
      host: "server9.ipsharkk.com",
      port: 29990,
      resolve: () => ({ host: "127.0.0.1", port: server.port }),
    });
    const socket = await transport.openControl();
    socket.write(Buffer.from("hello", "latin1"));
    assert.equal((await server.waitForBytes(5)).toString("latin1"), "hello");
    socket.destroy();
  } finally {
    await server.close();
  }
});

test("an exit tunnel XORs outbound bytes and opens with its target header", async () => {
  const server = await startListener();
  try {
    const transport = tunnelTransport(
      { host: "127.0.0.1", port: server.port },
      "server3.ipsharkk.com",
    );
    const socket = await transport.openSecond(8000);
    socket.write(Buffer.from("GET / HTTP/1.0\r\n\r\n", "latin1"));
    const header = xor73(Buffer.from("<h>server3.ipsharkk.com<p>8000</p></h>", "latin1"));
    const seen = await server.waitForBytes(header.length);
    assert.deepEqual(seen.subarray(0, header.length), header);
    socket.destroy();
  } finally {
    await server.close();
  }
});

test("inbound tunnel bytes are forwarded raw, never unmasked again", async () => {
  const server = await startListener();
  try {
    const transport = tunnelTransport({ host: "127.0.0.1", port: server.port }, "relay.test");
    const socket = await transport.openSecond(80);
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    await server.waitForBytes(1);
    server.sockets[0]!.write(Buffer.from("RESPONSE", "latin1"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(Buffer.concat(received).toString("latin1"), "RESPONSE");
    socket.destroy();
  } finally {
    await server.close();
  }
});

test("an exit tunnel that cannot connect logs the endpoint and the reason, then rejects", async () => {
  const lines: string[] = [];
  const dialer = exitTunnelDialer({
    relayHosts: ["server3.ipsharkk.com"],
    exitPort: 32516,
    label: "24.90.211.117:32516",
    log: (line) => lines.push(line),
    dial: async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:9");
    },
  });

  await assert.rejects(dialer(EXAMPLE), /ECONNREFUSED/);

  assert.equal(lines.length, 2, "one line for the attempt and one for the failure");
  assert.match(
    lines[0]!,
    /^exit 24\.90\.211\.117:32516 tunnel connecting for example\.com:443 host=server3\.ipsharkk\.com$/,
  );
  assert.match(
    lines[1]!,
    /^exit 24\.90\.211\.117:32516 tunnel connect failed for example\.com:443 host=server3\.ipsharkk\.com: .*ECONNREFUSED/,
  );
});

test("the exit tunnel writes the masked header before any payload, before it is handed back", async () => {
  forgetAcceptedTunnelVariant();
  const server = await startListener();
  const header = headerFor(EXAMPLE);
  const payload = Buffer.from("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n", "latin1");
  const recordings: RecordingSocket[] = [];
  const dialer = exitTunnelDialer({
    relayHosts: ["relay.test"],
    exitPort: 31000,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    openGraceMs: 60,
    dial: async (endpoint) => {
      const socket = await dialRecording(endpoint);
      recordings.push(socket);
      return socket;
    },
  });

  try {
    const tunnel = await dialer(EXAMPLE);
    assert.equal(recordings.length, 1);
    assert.deepEqual(
      recordings[0]!.writes,
      [header],
      "the header is written before the tunnel is handed back",
    );

    const seen = await server.waitForBytes(header.length);
    assert.deepEqual(seen.subarray(0, header.length), header);
    await settle();
    assert.equal(
      server.received().length,
      header.length,
      "the header arrives before any payload, with nothing else behind it",
    );

    tunnel.write(payload);
    const total = header.length + payload.length;
    const received = await server.waitForBytes(total);
    assert.deepEqual(received.subarray(0, header.length), header, "header first on the wire");
    assert.deepEqual(received.subarray(header.length, total), xor73(payload));
    tunnel.destroy();
  } finally {
    await server.close();
  }
});

test("the relay's inbound bytes reach the tunnel reader raw", async () => {
  forgetAcceptedTunnelVariant();
  const response = Buffer.from("HTTP/1.1 200 OK\r\n", "latin1");
  const server = await startListener({ onConnect: (socket) => socket.write(response) });
  const dialer = exitTunnelDialer({
    relayHosts: ["relay.test"],
    exitPort: 31001,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    openGraceMs: 60,
    dial: dialQuietly,
  });

  try {
    const tunnel = await dialer(EXAMPLE);
    const received = await readBytes(tunnel, response.length);
    assert.deepEqual(received, response, "inbound bytes are not XOR'd a second time");
    assert.notDeepEqual(received, xor73(response));
    tunnel.destroy();
  } finally {
    await server.close();
  }
});

test("an open host that says nothing is accepted: silence is the protocol", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const server = await startListener();
  const header = headerFor(EXAMPLE);
  const dialer = exitTunnelDialer({
    relayHosts: ["relay.test"],
    exitPort: 31002,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    openGraceMs: 80,
    log: (line) => lines.push(line),
    dial: dialQuietly,
  });

  try {
    const tunnel = await dialer(EXAMPLE);
    assert.equal(tunnel.destroyed, false, "a silent open host yields a usable tunnel");
    assert.ok(
      lines.some((line) =>
        line.includes("tunnel open for example.com:443 host=relay.test"),
      ),
      lines.join("\n"),
    );
    assert.equal(
      lines.some((line) => line.includes("hung up")),
      false,
      "silence was never mistaken for a refusal",
    );
    assert.deepEqual(await server.waitForBytes(header.length), header);
    tunnel.destroy();
  } finally {
    await server.close();
  }
});

test("a host that hangs up at once is skipped for the next relay host", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const hangingUp = await startListener({ onConnect: (socket) => socket.destroy() });
  const open = await startListener();
  const header = headerFor(EXAMPLE);
  const attempts: string[] = [];
  const dialer = exitTunnelDialer({
    relayHosts: ["first.relay.test", "second.relay.test"],
    exitPort: 31003,
    resolve: (host) => {
      attempts.push(host);
      return {
        host: "127.0.0.1",
        port: host === "first.relay.test" ? hangingUp.port : open.port,
      };
    },
    openGraceMs: 80,
    log: (line) => lines.push(line),
    dial: dialQuietly,
  });

  try {
    const tunnel = await dialer(EXAMPLE);
    assert.deepEqual(attempts, ["first.relay.test", "second.relay.test"]);
    assert.equal(hangingUp.connections, 1, "the refusing host is dialled once");
    assert.equal(hangingUp.received().length, 0, "it never received the header");
    assert.ok(
      lines.some((line) =>
        line.includes("host=first.relay.test hung up before the header"),
      ),
      lines.join("\n"),
    );
    assert.deepEqual(await open.waitForBytes(header.length), header);
    tunnel.destroy();
  } finally {
    await hangingUp.close();
    await open.close();
  }
});

test("hosts are tried in order, and the cached host is dialled first next time", async () => {
  forgetAcceptedTunnelVariant();
  const accepting = await startListener();
  const refused = await startListener();
  const refusedPort = refused.port;
  await refused.close(); // nothing listens here any more: TCP connect is refused

  const attempts: string[] = [];
  const header = headerFor(EXAMPLE);
  const dialer = exitTunnelDialer({
    relayHosts: ["dead.relay.test", "live.relay.test"],
    exitPort: 31004,
    resolve: (host) => {
      attempts.push(host);
      return {
        host: "127.0.0.1",
        port: host === "dead.relay.test" ? refusedPort : accepting.port,
      };
    },
    openGraceMs: 60,
    dial: dialQuietly,
  });

  try {
    const first = await dialer(EXAMPLE);
    assert.deepEqual(attempts, ["dead.relay.test", "live.relay.test"]);
    assert.deepEqual(await accepting.waitForBytes(header.length), header);
    first.destroy();

    const second = await dialer(EXAMPLE);
    assert.deepEqual(
      attempts.slice(2),
      ["live.relay.test"],
      "the accepted host is tried first, and the refused one is not redialled",
    );
    const both = await accepting.waitForBytes(header.length * 2);
    assert.deepEqual(both.subarray(header.length), header);
    second.destroy();
  } finally {
    await accepting.close();
  }
});

test("when every host hangs up the error names the exit port", async () => {
  forgetAcceptedTunnelVariant();
  const first = await startListener({ onConnect: (socket) => socket.destroy() });
  const second = await startListener({ onConnect: (socket) => socket.destroy() });
  const dialer = exitTunnelDialer({
    relayHosts: ["a.relay.test", "b.relay.test"],
    exitPort: 31005,
    resolve: (host) => ({
      host: "127.0.0.1",
      port: host === "a.relay.test" ? first.port : second.port,
    }),
    openGraceMs: 80,
    dial: dialQuietly,
  });

  try {
    await assert.rejects(
      dialer(EXAMPLE),
      /every relay host hung up exit port 31005: a\.relay\.test, b\.relay\.test/,
    );
    assert.equal(first.connections, 1);
    assert.equal(second.connections, 1, "each host is dialled exactly once");
  } finally {
    await first.close();
    await second.close();
  }
});

test("when no host can be dialled the last connect error is thrown", async () => {
  forgetAcceptedTunnelVariant();
  const dead = await startListener();
  const deadPort = dead.port;
  await dead.close();
  const dialer = exitTunnelDialer({
    relayHosts: ["a.relay.test", "b.relay.test"],
    exitPort: 31006,
    resolve: () => ({ host: "127.0.0.1", port: deadPort }),
    dial: dialQuietly,
  });

  await assert.rejects(dialer(EXAMPLE), /ECONNREFUSED/);
});

test("openGraceMs 0 still returns a tunnel for an open silent host", async () => {
  forgetAcceptedTunnelVariant();
  const server = await startListener();
  const header = headerFor(EXAMPLE);
  const dialer = exitTunnelDialer({
    relayHosts: ["relay.test"],
    exitPort: 31007,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    openGraceMs: 0,
    dial: dialQuietly,
  });

  try {
    const tunnel = await dialer(EXAMPLE);
    assert.equal(tunnel.destroyed, false);
    assert.deepEqual(await server.waitForBytes(header.length), header);
    tunnel.destroy();
  } finally {
    await server.close();
  }
});

test("the relay's first bytes are logged escaped, on one line, and never consumed", async () => {
  forgetAcceptedTunnelVariant();
  const answer = Buffer.from([0x48, 0x54, 0x54, 0x50, 0x00, 0x0a, 0xff]);
  const fake = new FakeTunnel(answer);
  const lines: string[] = [];
  const dialer = exitTunnelDialer({
    relayHosts: ["server3.ipsharkk.com"],
    exitPort: 32516,
    openGraceMs: 0,
    log: (line) => lines.push(line),
    dial: async () => fake,
  });

  const tunnel = await dialer(EXAMPLE);
  const received: Buffer[] = [];
  tunnel.on("data", (chunk: Buffer) => received.push(chunk));
  await waitFor(() => lines.some((line) => line.includes("relay said")));

  const said = lines.find((line) => line.includes("relay said"))!;
  assert.ok(
    lines.some((line) =>
      line.endsWith("tunnel open for example.com:443 host=server3.ipsharkk.com"),
    ),
    "a successful dial is logged before the caller uses the tunnel",
  );
  assert.ok(said.includes("relay said 7B: "), `the byte count is named: ${said}`);
  assert.ok(said.includes("HTTP"), "printable bytes are kept");
  assert.ok(said.includes("\\x00") && said.includes("\\x0a") && said.includes("\\xff"), said);
  assert.equal(said.includes("\n"), false, "a binary chunk cannot break the line");
  await waitFor(() => received.length > 0);
  assert.equal(Buffer.concat(received).toString("latin1"), answer.toString("latin1"));
  tunnel.destroy();
});

test("a binary first chunk is capped at 120 bytes in the log line", async () => {
  forgetAcceptedTunnelVariant();
  const fake = new FakeTunnel(Buffer.concat([Buffer.alloc(120, 0x41), Buffer.alloc(80, 0x42)]));
  const lines: string[] = [];
  const dialer = exitTunnelDialer({
    relayHosts: ["server3.ipsharkk.com"],
    exitPort: 32516,
    openGraceMs: 0,
    log: (line) => lines.push(line),
    dial: async () => fake,
  });

  const tunnel = await dialer(EXAMPLE);
  await waitFor(() => lines.some((line) => line.includes("relay said")));

  const said = lines.find((line) => line.includes("relay said"))!;
  assert.ok(said.includes("relay said 120B: "), said);
  const payload = said.slice(said.indexOf("relay said") + "relay said 120B: ".length);
  assert.ok(payload.includes("A".repeat(120)), "every one of the first 120 bytes is shown");
  assert.equal(payload.includes("BB"), false, "byte 121 is not logged");
  tunnel.destroy();
});
