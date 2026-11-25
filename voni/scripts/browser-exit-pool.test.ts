import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import {
  EXIT_ACQUIRE_WAIT_MS,
  acquireExit,
  parseControlUrl,
  releaseExit,
} from "./browser-exit-pool.mjs";

/**
 * The runner's half of the client's control API, proved against a local HTTP
 * server that speaks the same contract. Nothing here reaches the relay, and no
 * browser is started: these are the two calls a Click makes around its context.
 */

interface ControlRequest {
  method: string;
  url: string;
  body: string;
}

interface FakeControl {
  url: string;
  requests: ControlRequest[];
  close: () => Promise<void>;
}

async function startControl(
  handler: (request: ControlRequest, response: ServerResponse) => void,
): Promise<FakeControl> {
  const requests: ControlRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const seen: ControlRequest = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(seen);
      handler(seen, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake control server has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function exitFor(index: number) {
  return {
    exitId: `198.51.100.${20 + index}:${4100 + index}`,
    server: "server1.ipsharkk.com",
    ip: `198.51.100.${20 + index}`,
    country: "US",
    asn: "7018",
    city: "Dallas",
    state: "Texas",
    socksUrl: `socks5h://127.0.0.1:${4100 + index}`,
    localPort: 4100 + index,
  };
}

test("the control URL is loopback, plain HTTP and carries no credential", () => {
  const accepted = parseControlUrl("http://127.0.0.1:41000/");
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.url, "http://127.0.0.1:41000");

  for (const refused of [
    "https://127.0.0.1:41000",
    "http://proxy.example.com:41000",
    "http://user:pass@127.0.0.1:41000",
    "http://127.0.0.1:41000/acquire",
    "127.0.0.1:41000",
    "",
  ]) {
    const result = parseControlUrl(refused);
    assert.equal(result.ok, false, `${JSON.stringify(refused)} was accepted`);
  }
});

test("five clicks ask for five different exits and get a loopback SOCKS url each", async () => {
  let handed = 0;
  const control = await startControl((request, response) => {
    assert.equal(request.method, "GET");
    json(response, 200, exitFor(handed));
    handed += 1;
  });
  try {
    const seen = new Set<string>();
    for (let click = 0; click < 5; click += 1) {
      const acquired = await acquireExit(control.url);
      assert.equal(acquired.ok, true);
      if (!acquired.ok) return;
      assert.equal(acquired.exit.country, "US");
      assert.equal(
        acquired.exit.socksUrl,
        `socks5://127.0.0.1:${4100 + click}`,
        "Playwright is handed socks5, a scheme it accepts",
      );
      assert.equal(seen.has(acquired.exit.exitId), false, "a Click reuses no exit");
      seen.add(acquired.exit.exitId);
      assert.match(acquired.exit.exitId, /^198\.51\.100\.\d+:\d+$/);
    }
    assert.equal(seen.size, 5);
    assert.equal(control.requests.length, 5);
    for (const request of control.requests) {
      assert.equal(
        request.url,
        `/acquire?waitMs=${EXIT_ACQUIRE_WAIT_MS}`,
        "every Click asks the pool for the same bounded ten seconds",
      );
    }
  } finally {
    await control.close();
  }
});

test("a pool with no exit is a reason, not a thrown error", async () => {
  const control = await startControl((_request, response) => {
    json(response, 503, { reason: "no-us-exit" });
  });
  try {
    const acquired = await acquireExit(control.url);
    assert.deepEqual(acquired, {
      ok: false,
      reason: "no-us-exit",
      detail: "the pool answered 503 no-us-exit",
    });
  } finally {
    await control.close();
  }
});

test("a lease that would not go through a loopback exit is refused", async () => {
  for (const exit of [
    { ...exitFor(0), socksUrl: "socks5://proxy.example.com:1080" },
    { ...exitFor(0), socksUrl: "http://127.0.0.1:1080" },
    { ...exitFor(0), exitId: "" },
    { ...exitFor(0), country: "CA" },
  ]) {
    const control = await startControl((_request, response) => {
      json(response, 200, exit);
    });
    try {
      const acquired = await acquireExit(control.url);
      assert.equal(acquired.ok, false, `${JSON.stringify(exit)} was accepted`);
      if (acquired.ok) return;
      assert.equal(acquired.reason, "bad-exit");
    } finally {
      await control.close();
    }
  }
});

test("release posts the exit and its outcome, and accepts 204", async () => {
  const control = await startControl((request, response) => {
    if (request.url.startsWith("/acquire")) {
      json(response, 200, exitFor(0));
      return;
    }
    response.writeHead(204);
    response.end();
  });
  try {
    const acquired = await acquireExit(control.url);
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    const released = await releaseExit(control.url, acquired.exit.exitId, false);
    assert.deepEqual(released, { ok: true });

    const release = control.requests.find((request) => request.url === "/release");
    assert.ok(release, "the release reached the control port");
    assert.equal(release.method, "POST");
    assert.deepEqual(JSON.parse(release.body), {
      exitId: acquired.exit.exitId,
      ok: false,
    });
  } finally {
    await control.close();
  }
});

test("a release the control port refuses is reported, never thrown", async () => {
  const control = await startControl((_request, response) => {
    json(response, 500, { error: "release-failed" });
  });
  try {
    const released = await releaseExit(control.url, "198.51.100.20:4100", true);
    assert.equal(released.ok, false);
    if (released.ok) return;
    assert.match(released.detail, /500/);
  } finally {
    await control.close();
  }
});
