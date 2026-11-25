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
