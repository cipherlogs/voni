#!/usr/bin/env node
/**
 * The leak check: a real browser, the runner's own egress settings, the
 * runner's control client, and a page that reports the address it saw.
 *
 * The claim this proves is the one the feature cannot ship without: a Click
 * leaves the internet from its assigned exit and from nowhere else. The page is
 * served by a fake internet on loopback; the exit is a fake SOCKS5 listener
 * whose outbound socket is bound to the exit's address, so the address the page
 * observes IS the address the target would see. A connection that does not pass
 * through that listener arrives from the client's own address, and that is a
 * leak.
 *
 * Why the client is fake and the rest is real: proving the positive with the
 * real Tuxler client needs an account, a credential and the live relay, and a
 * check that cannot run on a pull request proves nothing. Everything above the
 * relay — `acquireExit`, the launch flags, the per-context proxy, the address
 * comparison — is the runner's own code. The scenarios below simulate each way
 * a Click can leave without its exit, using only loopback addresses:
 *
 *   assigned       the context uses the lease's SOCKS port      -> pass
 *   direct-context the context is opened without a proxy        -> LEAK
 *   derived-port   the lease names a port that routes directly  -> LEAK
 *   wrong-exit     the lease names another exit's address       -> LEAK
 *   listener-gone  the exit's listener is closed after acquire  -> LEAK
 *
 * Any leaked scenario exits 1. There is no warning path: a check that can go
 * green while the browser reached the internet directly is not a check.
 *
 * Usage: `node scripts/tuxler-exit-leak.mjs [scenario]`
 * Exit: 0 the assigned exit was observed; 1 a leak; 2 the check could not run.
 */

import { createServer } from "node:http";
import net from "node:net";

import { chromium } from "@playwright/test";

import { exitContextProxy, launchOptionsFor } from "./browser-egress.mjs";
import { acquireExit, parseControlUrl, releaseExit } from "./browser-exit-pool.mjs";
import { redactProxyText } from "./browser-proxy-redaction.mjs";

/** The address the fake exit answers from: the exit the page must observe. */
export const ASSIGNED_EXIT_IP = "127.0.0.2";
/** A different address in the same range, never used as an exit on its own. */
export const WRONG_EXIT_IP = "127.0.0.3";
/** Where a connection that skipped the exit arrives from. */
export const CLIENT_IP = "127.0.0.1";
/** How long a page may take to report its address before that is a failure. */
const PAGE_TIMEOUT_MS = 15_000;

export const SCENARIOS = [
  "assigned",
  "direct-context",
  "derived-port",
  "wrong-exit",
  "listener-gone",
];

/**
 * The verdict. The observed address is compared to the exit's exact address:
 * not its /24, not a country, not an ASN. A caller that compared anything less
 * specific could pass on a neighbour and call a leak a success.
 *
 * @param {object} input
 * @param {string | null} input.observed what the page reported, or null when
 *   the page never loaded
 * @param {string} input.exitIp the exit the Click was given
 * @param {string | null} [input.failure] why the page could not report
 * @param {object} [input.context] scenario, exit id and connections served,
 *   for a message a reader can act on
 * @returns {{ leaked: boolean, message: string }}
 */
export function compareObservedAddress({
  observed,
  exitIp,
  failure = null,
  context = {},
}) {
  const where = describeContext(context);
  if (observed === null || observed === undefined || observed.trim() === "") {
    return {
      leaked: true,
      message:
        `LEAK: nothing was observed through the assigned exit ${exitIp}` +
        ` (${failure ?? "the page reported no address"}); a browser that cannot prove its exit` +
        ` is a leak, not a warning${where}`,
    };
  }
  const seen = observed.trim();
  if (seen !== exitIp) {
    return {
      leaked: true,
      message:
        `LEAK: the page observed ${seen}, not the assigned exit ${exitIp};` +
        ` the browser reached the internet without its exit${where}`,
    };
  }
  return {
    leaked: false,
    message: `ok: the page observed ${seen}, which is the assigned exit${where}`,
  };
}

function describeContext({ scenario, exitId, served } = {}) {
  const parts = [];
  if (typeof scenario === "string") parts.push(`scenario=${scenario}`);
  if (typeof exitId === "string") parts.push(`exit=${exitId}`);
  if (typeof served === "number") parts.push(`connections-through-exit=${served}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * A SOCKS5 CONNECT listener that behaves like one exit.
 *
 * With a `bindAddress` it is an exit: every outbound socket leaves from that
 * address, so the target sees it. Without one it is the handshake port the
 * relay hands out when no change was asked for — it routes directly and exposes
 * the client's own address, which is the trap the spec names as the most
 * dangerous failure mode in the feature.
 *
 * @param {{ bindAddress?: string, port?: number }} [options]
 */
export function startSocksListener({ bindAddress, port = 0 } = {}) {
  const connections = { served: 0 };
  const server = net.createServer((client) => {
    let buffered = Buffer.alloc(0);
    let stage = "greeting";
    client.on("error", () => client.destroy());
    client.on("data", function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting") {
        if (buffered.length < 2) return;
        const methods = buffered[1];
        if (buffered.length < 2 + methods) return;
        client.write(Buffer.from([0x05, 0x00]));
        buffered = buffered.subarray(2 + methods);
        stage = "request";
      }
      if (stage !== "request") return;
      if (buffered.length < 5) return;
      const atyp = buffered[3];
      let host;
      let offset;
      if (atyp === 0x01) {
        if (buffered.length < 10) return;
        host = Array.from(buffered.subarray(4, 8)).join(".");
        offset = 8;
      } else if (atyp === 0x03) {
        const length = buffered[4];
        if (buffered.length < 5 + length + 2) return;
        host = buffered.subarray(5, 5 + length).toString("latin1");
        offset = 5 + length;
      } else {
        // Only the two address forms a Chromium proxy request uses.
        client.destroy();
        return;
      }
      const requestedPort = buffered.readUInt16BE(offset);
      buffered = buffered.subarray(offset + 2);
      stage = "piping";

      const upstream = net.connect(
        bindAddress === undefined ? { host, port: requestedPort } : { host, port: requestedPort, localAddress: bindAddress },
      );
      upstream.on("connect", () => {
        connections.served += 1;
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (buffered.length > 0) upstream.write(buffered);
        client.on("data", (next) => upstream.write(next));
        upstream.on("data", (next) => client.write(next));
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fake exit has no port"));
        return;
      }
      resolve({
        url: `socks5://127.0.0.1:${address.port}`,
        port: address.port,
        connections,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The fake internet: one page that reports the address that reached it. */
export function startFakeInternet() {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    // The address the target sees is the whole point of the page.
    response.end(
      "<!doctype html><title>leak check</title>" +
        `<div id="observed">${_request.socket.remoteAddress ?? ""}</div>`,
    );
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fake internet has no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * The client's loopback control API, answering with the lease a real client
 * would: an exit id, the exit's address, and its SOCKS port.
 *
 * @param {{ leaseIp: string, socksUrl: string }} lease
 */
export function startFakeClient({ leaseIp, socksUrl }) {
  const port = Number(new URL(socksUrl).port);
  const server = createServer((request, response) => {
    if (request.method === "GET" && (request.url ?? "").startsWith("/acquire")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          exitId: "leak-exit",
          server: null,
          ip: leaseIp,
          country: "US",
          asn: "7018",
          city: "Leak Check",
          socksUrl,
          localPort: port,
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/release") {
      request.resume();
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fake client has no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Run one scenario end to end and report whether the browser stayed inside its
 * exit. Throws only when the check itself could not run.
 *
 * @param {{ scenario?: string, channel?: string | undefined }} [options]
 */
export async function runLeakCheck({ scenario = "assigned", channel = undefined } = {}) {
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`unknown scenario ${scenario}; expected one of ${SCENARIOS.join(", ")}`);
  }

  const internet = await startFakeInternet();
  const exit = await startSocksListener({ bindAddress: ASSIGNED_EXIT_IP });
  // The derived port: same listener shape, no exit address behind it.
  const derived = await startSocksListener();
  const client = await startFakeClient({
    leaseIp: scenario === "wrong-exit" ? WRONG_EXIT_IP : ASSIGNED_EXIT_IP,
    socksUrl: scenario === "derived-port" ? derived.url : exit.url,
  });

  let browser;
  let observed = null;
  let failure = null;
  let exitId = null;
  let leaseIp = ASSIGNED_EXIT_IP;
  try {
    const control = parseControlUrl(client.url);
    if (!control.ok) throw new Error(`the fake control address was refused: ${control.reason}`);
    const taken = await acquireExit(control.url);
    if (!taken.ok) {
      throw new Error(`the fake client served no exit: ${taken.reason} ${taken.detail}`);
    }
    exitId = taken.exit.exitId;
    leaseIp = taken.exit.ip;

    // A listener that has gone away after the lease was handed out: the
    // browser will be told to use a port nobody answers on.
    if (scenario === "listener-gone") await exit.close();

    browser = await chromium.launch(
      launchOptionsFor({
        channel,
        // The fake internet is loopback. Chromium bypasses loopback implicitly,
        // so the harness has to ask for it to be proxied like a remote host;
        // the runner's flags themselves are unchanged.
        extraArgs: ["--proxy-bypass-list=<-loopback>"],
      }),
    );
    const context = await browser.newContext(
      scenario === "direct-context" ? {} : exitContextProxy(taken.exit),
    );
    const page = await context.newPage();
    await page.goto(internet.url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    observed = (await page.locator("#observed").innerText()).trim();
    await context.close();

    await releaseExit(control.url, taken.exit.exitId, observed === taken.exit.ip);
  } catch (error) {
    failure = (error instanceof Error ? error.message : String(error)).split("\n")[0].trim();
  } finally {
    await browser?.close().catch(() => {});
    await client.close();
    await exit.close().catch(() => {});
    await derived.close();
    await internet.close();
  }

  const verdict = compareObservedAddress({
    observed,
    exitIp: leaseIp,
    failure,
    context: { scenario, exitId, served: exit.connections.served },
  });
  return { ...verdict, scenario, observed, exitIp: leaseIp, served: exit.connections.served };
}

async function main() {
  const scenario = process.argv[2] ?? "assigned";
  if (!SCENARIOS.includes(scenario)) {
    console.error(`tuxler-exit-leak: scenario must be one of ${SCENARIOS.join(", ")}, got ${scenario}`);
    process.exit(2);
  }
  const channel = process.env.TUXLER_LEAK_CHANNEL?.trim() || undefined;

  let result;
  try {
    result = await runLeakCheck({ scenario, channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      redactProxyText(
        `tuxler-exit-leak: could not run (${message}); ` +
          "install a browser with `npx playwright install chromium`",
      ),
    );
    process.exit(2);
  }

  const line = redactProxyText(`tuxler-exit-leak: ${result.message}`);
  if (result.leaked) {
    console.error(line);
    process.exit(1);
  }
  console.log(line);
  process.exit(0);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  // No top-level await: the test imports this module through tsx, which would
  // have to emit CommonJS for it and cannot.
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactProxyText(`tuxler-exit-leak: could not run (${message})`));
    process.exit(2);
  });
}
