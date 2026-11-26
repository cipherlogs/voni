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
import { directTransport, exitTunnelDialer, tunnelTransport, xor73 } from "./transport";

/** A tunnel stand-in: the dialer wraps it, and the test decides what the relay says. */
class FakeTunnel extends Duplex {
  readonly written: Buffer[] = [];
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
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
    relayHost: "server3.ipsharkk.com",
    exitPort: 32516,
    label: "24.90.211.117:32516",
    log: (line) => lines.push(line),
    dial: async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:9");
    },
  });

  await assert.rejects(dialer({ host: "example.com", port: 443 }), /ECONNREFUSED/);

  assert.equal(lines.length, 2, "one line for the attempt and one for the failure");
  assert.match(lines[0]!, /^exit 24\.90\.211\.117:32516 tunnel connecting for example\.com:443$/);
  assert.match(
    lines[1]!,
    /^exit 24\.90\.211\.117:32516 tunnel connect failed for example\.com:443: .*ECONNREFUSED/,
  );
});

test("the relay's first bytes are logged escaped, on one line, and never consumed", async () => {
  const fake = new FakeTunnel();
  const lines: string[] = [];
  const dialer = exitTunnelDialer({
    relayHost: "server3.ipsharkk.com",
    exitPort: 32516,
    log: (line) => lines.push(line),
    dial: async () => fake,
  });

  const tunnel = await dialer({ host: "example.com", port: 443 });
  const received: Buffer[] = [];
  tunnel.on("data", (chunk: Buffer) => received.push(chunk));

  const answer = Buffer.from([0x48, 0x54, 0x54, 0x50, 0x00, 0x0a, 0xff]);
  fake.reply(answer);
  await waitFor(() => lines.some((line) => line.includes("relay said")));

  const said = lines.find((line) => line.includes("relay said"))!;
  assert.ok(said.includes("relay said 7B: "), `the byte count is named: ${said}`);
  assert.ok(said.includes("HTTP"), "printable bytes are kept");
  assert.ok(said.includes("\\x00") && said.includes("\\x0a") && said.includes("\\xff"), said);
  assert.equal(said.includes("\n"), false, "a binary chunk cannot break the line");
  assert.equal(Buffer.concat(received).toString("latin1"), answer.toString("latin1"));
  tunnel.destroy();
});

test("a binary first chunk is capped at 120 bytes in the log line", async () => {
  const fake = new FakeTunnel();
  const lines: string[] = [];
  const dialer = exitTunnelDialer({
    relayHost: "server3.ipsharkk.com",
    exitPort: 32516,
    log: (line) => lines.push(line),
    dial: async () => fake,
  });

  await dialer({ host: "example.com", port: 443 });
  fake.reply(Buffer.concat([Buffer.alloc(120, 0x41), Buffer.alloc(80, 0x42)]));
  await waitFor(() => lines.some((line) => line.includes("relay said")));

  const said = lines.find((line) => line.includes("relay said"))!;
  assert.ok(said.includes("relay said 120B: "), said);
  const payload = said.slice(said.indexOf("relay said") + "relay said 120B: ".length);
  assert.ok(payload.includes("A".repeat(120)), "every one of the first 120 bytes is shown");
  assert.equal(payload.includes("BB"), false, "byte 121 is not logged");
});

test("a tunnel that closes before answering says so", async () => {
  const fake = new FakeTunnel();
  const lines: string[] = [];
  const dialer = exitTunnelDialer({
    relayHost: "server3.ipsharkk.com",
    exitPort: 32516,
    log: (line) => lines.push(line),
    dial: async () => fake,
  });

  await dialer({ host: "example.com", port: 443 });
  fake.destroy();
  await waitFor(() => lines.some((line) => line.includes("closed the tunnel")));

  const said = lines.find((line) => line.includes("closed the tunnel"))!;
  assert.match(said, /relay closed the tunnel before the destination answered/);
  assert.ok(said.includes("example.com:443"), `the destination is named: ${said}`);
});
