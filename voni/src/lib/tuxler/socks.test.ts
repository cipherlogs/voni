/**
 * The loopback SOCKS5 listener, driven by a real SOCKS client.
 *
 * The one thing this file refuses to be is lenient: only loopback peers, only
 * CONNECT, and a destination that refuses is told so with a SOCKS reply instead of
 * an unexplained close. The tunnel itself is injected, so nothing here needs a relay.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { isLoopbackPeer, startSocksServer, type SocksTarget } from "./socks";

/** A tunnel stand-in: bytes written by the SOCKS side are collected, replies are pushed. */
class FakeTunnel extends Duplex {
  readonly written: Buffer[] = [];
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    callback();
  }
  reply(bytes: string): void {
    this.push(Buffer.from(bytes, "latin1"));
  }
  get text(): string {
    return Buffer.concat(this.written).toString("latin1");
  }
}

async function withServer(
  dial: (target: SocksTarget) => Promise<Duplex>,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = await startSocksServer({ dial, refusalWindowMs: 60 });
  try {
    await run(server.port);
  } finally {
    await server.close();
  }
}

/** Greet, ask for CONNECT, return the reply and the socket positioned after it. */
async function socksConnect(
  port: number,
  target: SocksTarget,
  command = 0x01,
): Promise<{ reply: Buffer; socket: net.Socket }> {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  await once(socket, "connect");
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await readExactly(socket, 2);
  assert.deepEqual([...greeting], [0x05, 0x00]);

  const host = Buffer.from(target.host, "latin1");
  const request = Buffer.concat([
    Buffer.from([0x05, command, 0x00, 0x03, host.length]),
    host,
    Buffer.from([target.port >> 8, target.port & 0xff]),
  ]);
  socket.write(request);
  const reply = await readExactly(socket, 10);
  return { reply, socket };
}

function readExactly(socket: net.Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= size) {
        socket.off("data", onData);
        socket.off("error", onError);
        resolve(buffer);
      }
    };
    const onError = (error: Error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/** Poll until the condition holds; the pipe is asynchronous, so read after, not with. */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a hostname destination is handed to the relay verbatim, and bytes flow both ways", async () => {
  const tunnel = new FakeTunnel();
  const seen: SocksTarget[] = [];
  await withServer(
    async (target) => {
      seen.push(target);
      return tunnel;
    },
    async (port) => {
      const { reply, socket } = await socksConnect(port, {
        host: "chatty.example.test",
        port: 443,
      });
      assert.equal(reply[1], 0x00, "a reachable destination must be granted");
      assert.deepEqual(seen, [{ host: "chatty.example.test", port: 443 }]);

      socket.write("ping");
      tunnel.reply("pong");
      const answer = await readExactly(socket, 4);
      assert.equal(answer.toString("latin1"), "pong");
      await waitFor(() => tunnel.text === "ping");
      socket.destroy();
    },
  );
});

test("a destination that refuses is told, not silently closed", async () => {
  await withServer(
    async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:9");
    },
    async (port) => {
      const { reply, socket } = await socksConnect(port, { host: "10.0.0.9", port: 9 });
      assert.equal(reply[0], 0x05);
      assert.equal(reply[1], 0x05, "reply 0x05 is `connection refused`");
      socket.destroy();
    },
  );
});

test("a tunnel that closes before the destination answers is a refusal too", async () => {
  await withServer(
    async () => {
      const tunnel = new FakeTunnel();
      tunnel.destroy();
      return tunnel;
    },
    async (port) => {
      const { reply, socket } = await socksConnect(port, { host: "gone.example.test", port: 80 });
      assert.equal(reply[1], 0x05);
      socket.destroy();
    },
  );
});

test("only CONNECT is accepted", async () => {
  await withServer(
    async () => new FakeTunnel(),
    async (port) => {
      const { reply, socket } = await socksConnect(port, { host: "example.test", port: 80 }, 0x02);
      assert.equal(reply[1], 0x07, "bind is not supported");
      socket.destroy();
    },
  );
});

test("a client that offers no acceptable method is refused", async () => {
  await withServer(
    async () => new FakeTunnel(),
    async (port) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      await once(socket, "connect");
      socket.write(Buffer.from([0x05, 0x01, 0x02]));
      const greeting = await readExactly(socket, 2);
      assert.deepEqual([...greeting], [0x05, 0xff]);
      socket.destroy();
    },
  );
});

test("the listener binds loopback only and refuses any other host", async () => {
  await assert.rejects(
    startSocksServer({ host: "0.0.0.0", dial: async () => new FakeTunnel() }),
    /loopback/,
  );
  await assert.rejects(
    startSocksServer({ host: "example.test", dial: async () => new FakeTunnel() }),
    /loopback/,
  );
  const server = await startSocksServer({ dial: async () => new FakeTunnel() });
  try {
    assert.equal(server.host, "127.0.0.1");
  } finally {
    await server.close();
  }
});

test("a peer is loopback or it is not", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackPeer(address), true, address);
  }
  for (const address of ["10.0.0.5", "192.168.1.20", "203.0.113.9", "::ffff:203.0.113.9", undefined]) {
    assert.equal(isLoopbackPeer(address), false, String(address));
  }
});
