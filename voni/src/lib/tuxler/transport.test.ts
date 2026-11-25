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
import { directTransport, tunnelTransport, xor73 } from "./transport";

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
