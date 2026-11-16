#!/usr/bin/env node
/**
 * Start N `wrangler dev` instances on 8787+i. Each gets its own generated
 * config (name + POOL_INDEX), inspector port, and local persistence dir so the
 * sessions do not collide.
 *
 * Dev allowlist adds localhost/127.0.0.1 on port 3000 so a pool worker can be
 * pointed at the local voni app.
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

const devHosts =
  process.env.EMAIL_POOL_DEV_TARGET_HOSTS ??
  "voni.cc,www.voni.cc,localhost:3000,127.0.0.1:3000,cipherlogs.github.io";

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
console.log(`  allowlist: ${devHosts} (ALLOW_PRIVATE_TARGETS=true)`);
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
      ALLOWED_TARGET_HOSTS: devHosts,
      ALLOW_PRIVATE_TARGETS: "true",
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
