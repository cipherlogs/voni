/**
 * A relay that is not there at all: the failure the runner must survive.
 *
 * These need no full relay, only a single answer, and they prove each failure is
 * classified for what it is — a connection problem, or a redirect that led
 * nowhere — so an operator is not sent looking at the wrong thing.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { TuxlerSessionError, startSession } from "./control";
import { encodeServerFrame } from "./frames";

const CREDENTIALS = { email: "operator@example.test", password: "correct-horse-battery" };

test("a relay that refuses the first connection reports connect-failed", async () => {
  await assert.rejects(
    startSession({
      ...CREDENTIALS,
      host: "server1.ipsharkk.com",
      port: 29_990,
      // Port 1 on loopback: nothing listens, and nothing leaves the machine.
      resolveEndpoint: () => ({ host: "127.0.0.1", port: 1 }),
      stageTimeoutMs: 2_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TuxlerSessionError, String(error));
      assert.equal(error.reason, "connect-failed");
      return true;
    },
  );
});

test("a CONNECT_LIST redirect that leads nowhere reports redirect-failed", async () => {
  const server = net.createServer((socket) => {
    socket.write(encodeServerFrame("CONNECT_LIST", "3;"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    await assert.rejects(
      startSession({
        ...CREDENTIALS,
        host: "server1.ipsharkk.com",
        port: 29_990,
        resolveEndpoint: (host: string) =>
          host === "server1.ipsharkk.com"
            ? { host: "127.0.0.1", port: address.port }
            : { host: "127.0.0.1", port: 1 },
        stageTimeoutMs: 2_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof TuxlerSessionError, String(error));
        assert.equal(error.reason, "redirect-failed");
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("a server that refuses is skipped for the next one the relay named", async () => {
  // A real run died `redirect-failed` on ECONNREFUSED while the relay's own
  // CONNECT_LIST named three servers and only the first was tried.
  const live = net.createServer((socket) => {
    socket.write(encodeServerFrame("CONNECT_LIST", "3;5;7;"));
  });
  live.listen(0, "127.0.0.1");
  await once(live, "listening");
  const address = live.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const second = net.createServer((socket) => {
    // It answers, and not with a conformance challenge: the session fails at the
    // next stage at once, which is all this test needs. A `MAKE_TEST_` frame here
    // would send the client probing example.com over the real network.
    socket.write(encodeServerFrame("LOGIN_REJECTED", "not in this test"));
    socket.on("error", () => {});
    socket.on("data", () => {});
  });
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  const secondAddress = second.address();
  if (secondAddress === null || typeof secondAddress === "string") throw new Error("no port");

  const dialled: string[] = [];
  try {
    await assert.rejects(
      startSession({
        ...CREDENTIALS,
        host: "server1.ipsharkk.com",
        port: 29_990,
        // server1 is the entry and answers CONNECT_LIST; server3 and server5 are
        // dead; server7 answers.
        resolveEndpoint: (host: string) => {
          dialled.push(host);
          if (host === "server1.ipsharkk.com") return { host: "127.0.0.1", port: address.port };
          if (host === "server7.ipsharkk.com") return { host: "127.0.0.1", port: secondAddress.port };
          return { host: "127.0.0.1", port: 1 };
        },
        stageTimeoutMs: 1_000,
      }),
      // It gets past the redirect and fails at the next stage, which is the proof
      // the dead server did not end the session.
      (error: unknown) => {
        assert.ok(error instanceof TuxlerSessionError, String(error));
        assert.notEqual(error.reason, "redirect-failed", `reason was ${error.reason}`);
        return true;
      },
    );
  } finally {
    // The session is rejected mid-handshake, so its sockets outlive it unless the
    // test closes them: a listening server alone would keep the file's process up.
    (live as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    (second as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    live.close();
    second.close();
  }
  assert.deepEqual(
    dialled,
    ["server1.ipsharkk.com", "server3.ipsharkk.com", "server5.ipsharkk.com", "server7.ipsharkk.com"],
    "the entry, then every listed server in order until one answered",
  );
});
