/**
 * The socket layer between the client and the relay.
 *
 * Two properties are load-bearing and both are proved here: only the outbound
 * direction of an exit tunnel is XOR-0x73 masked (inbound bytes arrive raw), and a
 * nested hop opens the relay's connection with a `<h>host<p>port</p></h>` header.
 * The endpoint resolver is the one seam a test uses in place of DNS — a test-only
 * mapping of `serverN.ipsharkk.com` to loopback, never a behaviour switch.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { Duplex } from "node:stream";
import {
  directTransport,
  exitTunnelDialer,
  forgetAcceptedTunnelVariant,
  tunnelTransport,
  xor73,
} from "./transport";

/**
 * A tunnel stand-in: the dialer wraps it, and the test decides what the relay
 * says. `autoReply` answers the first frame, because a dial only succeeds once
 * the relay has produced evidence.
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


interface Listener {
  port: number;
  sockets: net.Socket[];
  received: () => Buffer;
  waitForBytes: (count: number, timeoutMs?: number) => Promise<Buffer>;
  close: () => Promise<void>;
}

async function startListener(): Promise<Listener> {
  const sockets: net.Socket[] = [];
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  const received = () => Buffer.concat(chunks);
  return {
    port: address.port,
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

type FramingVerdict = "answer" | "close" | "silent";

/** The first bytes of each framing the dialer may send. */
const MASKED_HEADER = xor73(Buffer.from("<h>", "latin1"));
const looksMaskedHeader = (frame: Buffer): boolean => frame.subarray(0, 3).equals(MASKED_HEADER);
const looksPlainHeader = (frame: Buffer): boolean =>
  frame.subarray(0, 3).toString("latin1") === "<h>";
const looksConnect = (frame: Buffer): boolean =>
  frame.subarray(0, 8).toString("latin1") === "CONNECT ";

interface FramingServer {
  port: number;
  connections: number;
  /** The first chunk each connection carried, in arrival order. */
  firstFrames: Buffer[];
  /** Every chunk every connection carried. */
  chunks: Buffer[];
  close: () => Promise<void>;
}

/** A relay stand-in that decides what to do from the frame it was sent. */
async function startFramingServer(
  decide: (frame: Buffer) => FramingVerdict,
): Promise<FramingServer> {
  const sockets: net.Socket[] = [];
  const firstFrames: Buffer[] = [];
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let first = true;
    socket.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      if (!first) return;
      first = false;
      firstFrames.push(Buffer.from(chunk));
      const verdict = decide(chunk);
      if (verdict === "answer") socket.write("ACK\r\n");
      else if (verdict === "close") socket.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  return {
    port: address.port,
    get connections() {
      return sockets.length;
    },
    firstFrames,
    chunks,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test("xor73 masks every byte with 0x73", () => {
  const masked = xor73(Buffer.from("abc", "latin1"));
  assert.deepEqual([...masked], [0x61 ^ 0x73, 0x62 ^ 0x73, 0x63 ^ 0x73]);
  assert.deepEqual([...xor73(masked)], [0x61, 0x62, 0x63]);
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
    server.sockets[0].write(Buffer.from("RESPONSE", "latin1"));
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

  await assert.rejects(dialer({ host: "example.com", port: 443 }), /ECONNREFUSED/);

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

test("the relay's first bytes are logged escaped, on one line, and never consumed", async () => {
  forgetAcceptedTunnelVariant();
  const answer = Buffer.from([0x48, 0x54, 0x54, 0x50, 0x00, 0x0a, 0xff]);
  const fake = new FakeTunnel(answer);
  const lines: string[] = [];
  const dialer = exitTunnelDialer({
    relayHosts: ["server3.ipsharkk.com"],
    exitPort: 32516,
    probeWindowMs: 100,
    log: (line) => lines.push(line),
    dial: async () => fake,
  });

  const tunnel = await dialer({ host: "example.com", port: 443 });
  const received: Buffer[] = [];
  tunnel.on("data", (chunk: Buffer) => received.push(chunk));
  await waitFor(() => lines.some((line) => line.includes("relay said")));

  const said = lines.find((line) => line.includes("relay said"))!;
  assert.ok(
    lines.some((line) =>
      line.endsWith("tunnel connected for example.com:443 host=server3.ipsharkk.com"),
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
    probeWindowMs: 100,
    log: (line) => lines.push(line),
    dial: async () => fake,
  });

  const tunnel = await dialer({ host: "example.com", port: 443 });
  await waitFor(() => lines.some((line) => line.includes("relay said")));

  const said = lines.find((line) => line.includes("relay said"))!;
  assert.ok(said.includes("relay said 120B: "), said);
  const payload = said.slice(said.indexOf("relay said") + "relay said 120B: ".length);
  assert.ok(payload.includes("A".repeat(120)), "every one of the first 120 bytes is shown");
  assert.equal(payload.includes("BB"), false, "byte 121 is not logged");
  tunnel.destroy();
});

test("a cached tunnel that closes before answering says so", async () => {
  forgetAcceptedTunnelVariant();
  const first = new FakeTunnel(Buffer.from([0x00]));
  const second = new FakeTunnel();
  const fakes = [first, second];
  const lines: string[] = [];
  const dialer = exitTunnelDialer({
    relayHosts: ["server3.ipsharkk.com"],
    exitPort: 32516,
    probeWindowMs: 100,
    log: (line) => lines.push(line),
    dial: async () => fakes.shift()!,
  });

  // The first dial proves a framing and caches it; the second takes it directly.
  (await dialer({ host: "example.com", port: 443 })).destroy();
  const tunnel = await dialer({ host: "example.com", port: 443 });
  second.destroy();
  await waitFor(() => lines.some((line) => line.includes("closed the tunnel")));

  const said = lines.find((line) => line.includes("closed the tunnel"))!;
  assert.match(said, /relay closed the tunnel before the destination answered/);
  assert.ok(said.includes("example.com:443"), `the destination is named: ${said}`);
  tunnel.destroy();
});

test("a framing the relay closes is abandoned for the next one, and the winner carries the tunnel", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const server = await startFramingServer((frame) => (looksPlainHeader(frame) ? "answer" : "close"));
  const dialer = exitTunnelDialer({
    relayHosts: ["server110.ipsharkk.com"],
    exitPort: 31972,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    probeWindowMs: 120,
    label: "server110:31972",
    log: (line) => lines.push(line),
  });

  try {
    const tunnel = await dialer({ host: "example.com", port: 443 });
    assert.ok(
      lines.some((line) =>
        line.includes(
          "host=server110.ipsharkk.com variant=masked-header closed with no bytes; trying next",
        ),
      ),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) =>
        /host=server110\.ipsharkk\.com variant=plain-header accepted \(first byte in \d+ ms\)/.test(
          line,
        ),
      ),
      lines.join("\n"),
    );
    assert.equal(server.firstFrames.length, 2, "one socket per framing, none reused");
    assert.ok(looksPlainHeader(server.firstFrames[1]!));

    // The probe's byte reached the caller, and payload is masked for this variant.
    const received: Buffer[] = [];
    tunnel.on("data", (chunk: Buffer) => received.push(chunk));
    await waitFor(() => received.length > 0);
    assert.equal(Buffer.concat(received).toString("latin1"), "ACK\r\n");

    tunnel.write(Buffer.from("GET / HTTP/1.0\r\n\r\n", "latin1"));
    const payload = xor73(Buffer.from("GET / HTTP/1.0\r\n\r\n", "latin1"));
    await waitFor(() => server.chunks.some((chunk) => chunk.equals(payload)));
    tunnel.destroy();
  } finally {
    await server.close();
  }
});

test("a relay that closes every framing is refused once, naming each variant", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const server = await startFramingServer(() => "close");
  const dialer = exitTunnelDialer({
    relayHosts: ["server110.ipsharkk.com"],
    exitPort: 31972,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    probeWindowMs: 120,
    log: (line) => lines.push(line),
  });

  try {
    await assert.rejects(
      dialer({ host: "www.google.com", port: 443 }),
      /tried server110\.ipsharkk\.com\/masked-header, server110\.ipsharkk\.com\/plain-header, server110\.ipsharkk\.com\/plain, server110\.ipsharkk\.com\/connect/,
    );
    await waitFor(() => server.firstFrames.length === 4);

    for (const name of ["masked-header", "plain-header", "plain", "connect"]) {
      const rejections = lines.filter((line) =>
        line.includes(`variant=${name} closed with no bytes`),
      );
      assert.equal(rejections.length, 1, `${name} is attempted exactly once`);
    }
    assert.equal(server.connections, 4, "one socket per variant, none reused");
    assert.equal(server.firstFrames.filter(looksMaskedHeader).length, 1);
    assert.equal(server.firstFrames.filter(looksConnect).length, 1);    assert.ok(
      lines.some((line) =>
        line.includes(
          "no candidate answered for www.google.com:443; tried " +
            "server110.ipsharkk.com/masked-header, server110.ipsharkk.com/plain-header, " +
            "server110.ipsharkk.com/plain, server110.ipsharkk.com/connect",
        ),
      ),
      lines.join("\n"),
    );
  } finally {
    await server.close();
  }
});

test("the accepted framing is cached and the second dial goes straight to it", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const server = await startFramingServer((frame) => (looksPlainHeader(frame) ? "answer" : "close"));
  const dialer = exitTunnelDialer({
    relayHosts: ["server110.ipsharkk.com"],
    exitPort: 31972,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    probeWindowMs: 120,
    log: (line) => lines.push(line),
  });

  try {
    (await dialer({ host: "example.com", port: 443 })).destroy();
    await waitFor(() => server.firstFrames.length === 2);
    assert.equal(server.connections, 2, "the sweep found the winner on the second framing");

    const tunnel = await dialer({ host: "example.com", port: 443 });
    await waitFor(() => server.firstFrames.length === 3);
    assert.equal(server.connections, 3, "the cached dial opens exactly one socket");
    assert.equal(
      server.firstFrames.filter(looksMaskedHeader).length,
      1,
      "the rejected framing is never probed again",
    );
    assert.ok(looksPlainHeader(server.firstFrames[2]!));
    assert.equal(
      lines.filter((line) => line.includes("variant=masked-header")).length,
      1,
      "the rejected framing is named once across both dials",
    );
    assert.ok(
      lines.some((line) =>
        line.includes("variant=plain-header reused (accepted earlier in this process)"),
      ),
      lines.join("\n"),
    );
    tunnel.destroy();
  } finally {
    await server.close();
  }
});

test("a relay that stays open but says nothing is refused: silence is not acceptance", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const server = await startFramingServer(() => "silent");
  const dialer = exitTunnelDialer({
    relayHosts: ["server110.ipsharkk.com"],
    exitPort: 31972,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    probeWindowMs: 40,
    log: (line) => lines.push(line),
  });

  try {
    await assert.rejects(
      dialer({ host: "example.com", port: 443 }),
      /unverified framing must never carry traffic/,
    );
    await waitFor(() => server.firstFrames.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      lines.some((line) =>
        line.includes("variant=masked-header stayed open for 40 ms with no bytes"),
      ),
      lines.join("\n"),
    );
    assert.equal(server.connections, 1, "silence ends the sweep: no further framing is tried");
    assert.equal(server.firstFrames.length, 1);
  } finally {
    await server.close();
  }
});

/** Maps a relay host name onto its loopback framing server. */
function hostMap(servers: Record<string, FramingServer>) {
  return (host: string) => {
    const server = servers[host];
    if (server === undefined) throw new Error(`no loopback server for ${host}`);
    return { host: "127.0.0.1", port: server.port };
  };
}

/** A data channel that hangs up as soon as a tunnel frame is written to it. */
class RejectingChannel extends Duplex {
  writes = 0;
  _read(): void {}
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes += 1;
    this.destroy();
    callback();
  }
}

test("a host that closes every framing is abandoned for the entry host", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const exitHost = await startFramingServer(() => "close");
  const entryHost = await startFramingServer((frame) => (looksMaskedHeader(frame) ? "answer" : "close"));
  const dialer = exitTunnelDialer({
    relayHosts: ["server119.ipsharkk.com", "server1.ipsharkk.com"],
    exitPort: 30160,
    resolve: hostMap({
      "server119.ipsharkk.com": exitHost,
      "server1.ipsharkk.com": entryHost,
    }),
    probeWindowMs: 120,
    label: "server119:30160",
    log: (line) => lines.push(line),
  });

  try {
    const tunnel = await dialer({ host: "example.com", port: 443 });
    assert.equal(exitHost.connections, 4, "every framing on the exit host was tried once");
    assert.equal(entryHost.connections, 1, "the entry host answered the current best guess");
    assert.ok(
      lines.some((line) =>
        line.includes(
          "host=server119.ipsharkk.com variant=masked-header closed with no bytes; trying next",
        ),
      ),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) =>
        line.includes("host=server1.ipsharkk.com variant=masked-header accepted"),
      ),
      lines.join("\n"),
    );

    const received: Buffer[] = [];
    tunnel.on("data", (chunk: Buffer) => received.push(chunk));
    await waitFor(() => received.length > 0);
    assert.equal(Buffer.concat(received).toString("latin1"), "ACK\r\n");
    tunnel.destroy();
  } finally {
    await exitHost.close();
    await entryHost.close();
  }
});

test("a session's data channel is used after the port framings fail", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const channel = new FakeTunnel(Buffer.from("ACK\r\n"));
  let borrowed = 0;
  const dialer = exitTunnelDialer({
    relayHosts: ["server119.ipsharkk.com"],
    exitPort: 30160,
    probeWindowMs: 120,
    label: "server119:30160",
    log: (line) => lines.push(line),
    dial: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    },
    dataChannel: () => {
      borrowed += 1;
      return channel;
    },
  });

  const tunnel = await dialer({ host: "example.com", port: 443 });
  const header = xor73(Buffer.from("<h>example.com<p>443</p></h>", "latin1"));
  assert.equal(borrowed, 1, "the accessor is called once, after the port candidates");
  assert.deepEqual(channel.written[0], header, "the channel carries the tunnel header");
  assert.ok(
    lines.some((line) =>
      line.includes("tunnel accepted on data-channel for example.com:443"),
    ),
    lines.join("\n"),
  );

  const received: Buffer[] = [];
  tunnel.on("data", (chunk: Buffer) => received.push(chunk));
  await waitFor(() => received.length > 0);
  assert.equal(Buffer.concat(received).toString("latin1"), "ACK\r\n");
  tunnel.destroy();
});

test("a data channel that is already in use is skipped, never queued", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const server = await startFramingServer(() => "close");
  let borrowed = 0;
  const dialer = exitTunnelDialer({
    relayHosts: ["server119.ipsharkk.com"],
    exitPort: 30160,
    resolve: () => ({ host: "127.0.0.1", port: server.port }),
    probeWindowMs: 120,
    log: (line) => lines.push(line),
    dataChannel: () => {
      borrowed += 1;
      return null;
    },
  });

  try {
    await assert.rejects(
      dialer({ host: "example.com", port: 443 }),
      /closed every tunnel framing/,
    );
    assert.equal(borrowed, 1, "a busy channel is asked about once, not queued");
    assert.equal(
      lines.filter((line) => line.includes("variant=data-channel busy or absent; skipped")).length,
      1,
    );
  } finally {
    await server.close();
  }
});

test("a data-channel rejection ends the sweep instead of retrying that socket", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const channel = new RejectingChannel();
  let borrowed = 0;
  const dialer = exitTunnelDialer({
    relayHosts: ["server119.ipsharkk.com"],
    exitPort: 30160,
    probeWindowMs: 120,
    log: (line) => lines.push(line),
    dial: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    },
    dataChannel: () => {
      borrowed += 1;
      return channel;
    },
  });

  await assert.rejects(
    dialer({ host: "example.com", port: 443 }),
    /the relay closed the data-channel framing/,
  );
  assert.equal(borrowed, 1, "the channel is borrowed once");
  assert.equal(channel.writes, 1, "the rejected socket is never written to twice");
  assert.ok(
    lines.some((line) =>
      line.includes("variant=data-channel closed with no bytes; the relay hung up"),
    ),
    lines.join("\n"),
  );
});

test("two hosts that close everything are each logged once per framing, with no loop", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const first = await startFramingServer(() => "close");
  const second = await startFramingServer(() => "close");
  const hosts = ["server119.ipsharkk.com", "server1.ipsharkk.com"];
  const dialer = exitTunnelDialer({
    relayHosts: hosts,
    exitPort: 30160,
    resolve: hostMap({
      "server119.ipsharkk.com": first,
      "server1.ipsharkk.com": second,
    }),
    probeWindowMs: 120,
    log: (line) => lines.push(line),
  });

  try {
    await assert.rejects(dialer({ host: "example.com", port: 443 }), /tried /);
    await waitFor(() => first.connections === 4 && second.connections === 4);
    for (const host of hosts) {
      for (const name of ["masked-header", "plain-header", "plain", "connect"]) {
        const attempts = lines.filter((line) =>
          line.includes(`host=${host} variant=${name} closed with no bytes`),
        );
        assert.equal(attempts.length, 1, `${host} ${name} is attempted exactly once`);
      }
    }
    assert.equal(first.connections + second.connections, 8, "one socket per candidate");
  } finally {
    await first.close();
    await second.close();
  }
});

test("the winning host and framing are cached, so the next dial goes straight to them", async () => {
  forgetAcceptedTunnelVariant();
  const lines: string[] = [];
  const exitHost = await startFramingServer(() => "close");
  const entryHost = await startFramingServer((frame) =>
    looksPlainHeader(frame) ? "answer" : "close",
  );
  const dialer = exitTunnelDialer({
    relayHosts: ["server119.ipsharkk.com", "server1.ipsharkk.com"],
    exitPort: 30160,
    resolve: hostMap({
      "server119.ipsharkk.com": exitHost,
      "server1.ipsharkk.com": entryHost,
    }),
    probeWindowMs: 120,
    log: (line) => lines.push(line),
  });

  try {
    (await dialer({ host: "example.com", port: 443 })).destroy();
    assert.equal(exitHost.connections, 4, "the exit host was swept first");
    assert.equal(entryHost.connections, 2, "the entry host answered on its second framing");

    const tunnel = await dialer({ host: "example.com", port: 443 });
    assert.equal(exitHost.connections, 4, "the cached dial never revisits the exit host");
    assert.equal(entryHost.connections, 3, "the cached dial opens exactly one socket");
    await waitFor(() => entryHost.firstFrames.length === 3);
    assert.ok(
      looksPlainHeader(entryHost.firstFrames[2]!),
      "the cached pair is the framing that answered",
    );
    assert.ok(
      lines.some((line) =>
        line.includes("variant=plain-header reused (accepted earlier in this process)"),
      ),
      lines.join("\n"),
    );
    tunnel.destroy();
  } finally {
    await exitHost.close();
    await entryHost.close();
  }
});

