#!/usr/bin/env node
/**
 * Start N `wrangler dev` instances on 8787+i. Each gets its own generated
 * config (name + POOL_INDEX), inspector port, and local persistence dir so the
 * sessions do not collide.
 *
 * No target list is injected: the worker fetches any absolute http(s) URL, so
 * a pool instance can be pointed at the local voni app or any public site.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  instanceName,
  poolSize,
  projectRoot,
  readBaseConfig,
  wranglerBin,
  writeInstanceConfig,
} from "./wrangler-bin.mjs";

const size = poolSize();
const basePort = Number.parseInt(process.env.EMAIL_POOL_PORT ?? "8787", 10);
if (!Number.isFinite(basePort)) {
  throw new Error(
    `EMAIL_POOL_PORT must be a number, got "${process.env.EMAIL_POOL_PORT}"`,
  );
}

// Local-only shared secret so the curl examples work out of the box. Prod
// sets POOL_SECRET with `wrangler secret put`, never as a var.
const devSecret = process.env.EMAIL_POOL_SECRET ?? "dev-pool-secret";

const bin = wranglerBin();
const base = readBaseConfig();
const configDir = join(projectRoot, ".wrangler", "dev-config");
const children = [];
let shuttingDown = false;

console.log(`email-pool dev: ${size} instance(s), wrangler ${bin}`);
for (let i = 0; i < size; i += 1) {
  console.log(`  ${instanceName("email-pool", i)}  http://localhost:${basePort + i}`);
}
console.log(`  targets: any absolute http(s) URL, redirects followed`);
console.log(`  x-pool-secret: ${devSecret}\n`);

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = code;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

for (let i = 0; i < size; i += 1) {
  const name = instanceName("email-pool", i);
  const port = basePort + i;
  const configPath = writeInstanceConfig(configDir, base, {
    name,
    index: i,
    vars: {
      POOL_SECRET: devSecret,
    },
  });

  const child = spawn(
    bin,
    [
      "dev",
      "--config",
      configPath,
      "--port",
      String(port),
      "--inspector-port",
      String(port + 1000),
      "--persist-to",
      join(projectRoot, ".wrangler", "state", name),
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );
  children.push(child);

  child.on("error", (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited (code=${code}, signal=${signal})`);
    shutdown(code ?? 1);
  });
}
