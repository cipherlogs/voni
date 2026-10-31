#!/usr/bin/env node
/**
 * Local TLS/WSS front for the cascade pipeline (demo-cascade ticket 21).
 *
 * The app has exactly one runtime pipeline base and it must be `https`
 * (ticket 08); the browser derives `wss` from it. The pipeline itself speaks
 * plain HTTP/WS on an internal port, so this process terminates TLS on the
 * public port and forwards both ordinary requests and WebSocket upgrades.
 *
 * It deliberately has no `http` mode and no "ignore certificate" switch: the
 * launcher resolves a certificate or refuses to start. The certificate is a
 * local dev cert (or a developer-supplied trusted pair) and is never committed.
 *
 *   node scripts/pipeline-tls-front.mjs --listen 8766 --target 8767 \
 *     --cert .dev-certs/pipeline.crt --key .dev-certs/pipeline.key
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    listen: { type: "string", default: "8766" },
    target: { type: "string", default: "8767" },
    host: { type: "string", default: "127.0.0.1" },
    cert: { type: "string" },
    key: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(
    "usage: pipeline-tls-front.mjs --cert PATH --key PATH [--listen 8766] [--target 8767] [--host 127.0.0.1]",
  );
  process.exit(0);
}

if (!values.cert || !values.key) {
  console.error("[tls-front] REFUSE: both --cert and --key are required.");
  process.exit(2);
}

const listenPort = Number(values.listen);
const targetPort = Number(values.target);
if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
  console.error("[tls-front] REFUSE: --listen and --target must be ports.");
  process.exit(2);
}

let tlsOptions;
try {
  tlsOptions = {
    cert: readFileSync(values.cert),
    key: readFileSync(values.key),
  };
} catch (error) {
  console.error(
    `[tls-front] REFUSE: cannot read the local certificate: ${error.message}`,
  );
  process.exit(2);
}

/** Forward one ordinary HTTP request to the plain pipeline. */
function forwardRequest(req, res) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`pipeline unreachable: ${error.message}`);
  });
  req.pipe(upstream);
}

/** Forward a WebSocket upgrade byte-for-byte after re-serialising the head. */
function forwardUpgrade(req, socket, head) {
  const upstream = net.connect(targetPort, "127.0.0.1", () => {
    let request = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      request += `${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}\r\n`;
    }
    upstream.write(`${request}\r\n`);
    if (head?.length) upstream.write(head);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.pipe(socket);
  socket.pipe(upstream);
}

const servers = [];
for (const host of ["127.0.0.1", "::1"]) {
  const server = https.createServer(tlsOptions, forwardRequest);
  server.on("upgrade", forwardUpgrade);
  server.on("tlsClientError", (error) => {
    // A plain TCP probe of the port (the launcher's readiness check) produces
    // "socket hang up"; a real handshake failure is worth naming.
    if (/socket hang up|ECONNRESET/i.test(error.message)) return;
    console.error(`[tls-front] client TLS error: ${error.message}`);
  });
  server.on("error", (error) => {
    // A bind failure is fatal: the launcher must not sit on a half-open front.
    console.error(`[tls-front] FAILED on ${host}:${listenPort}: ${error.message}`);
    process.exit(1);
  });
  server.listen(listenPort, host, () => {
    console.log(`[tls-front] https://${host === "::1" ? "localhost" : host}:${listenPort} -> 127.0.0.1:${targetPort}`);
  });
  servers.push(server);
}

function shutdown() {
  for (const server of servers) server.close();
  // Sockets are short-lived here; do not hold the command open after a stop.
  setTimeout(() => process.exit(0), 250);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
