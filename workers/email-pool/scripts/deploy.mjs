#!/usr/bin/env node
/**
 * Deploy N instances (email-pool-01..NN) of the same worker source.
 *
 * Per-instance config is generated from wrangler.jsonc into a gitignored temp
 * dir (.wrangler/deploy-config/) with `name` and `POOL_INDEX` overridden, then
 * `wrangler deploy --config <file>` runs for each. Extra CLI args (for example
 * --dry-run) pass straight through to wrangler.
 */
import { spawnSync } from "node:child_process";
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
const prefix = process.env.EMAIL_POOL_PREFIX ?? "email-pool";
const bin = wranglerBin();
const passthrough = process.argv.slice(2);
const dryRun = passthrough.includes("--dry-run");

const base = readBaseConfig();
const configDir = join(projectRoot, ".wrangler", "deploy-config");

if (!process.env.CLOUDFLARE_API_TOKEN && !dryRun) {
  console.warn(
    "[email-pool] CLOUDFLARE_API_TOKEN is not set; relying on an existing `wrangler login` session.",
  );
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID && !dryRun) {
  console.warn(
    "[email-pool] CLOUDFLARE_ACCOUNT_ID is not set; wrangler will use the account from your session.",
  );
}

const deployed = [];

for (let i = 0; i < size; i += 1) {
  const name = instanceName(prefix, i);
  const configPath = writeInstanceConfig(configDir, base, { name, index: i });
  console.log(`\n[email-pool] ${name} (POOL_INDEX=${i}) -> ${configPath}`);

  const result = spawnSync(
    bin,
    ["deploy", "--config", configPath, ...passthrough],
    { cwd: projectRoot, stdio: "inherit" },
  );

  if (result.error) {
    console.error(`[email-pool] ${name} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[email-pool] ${name} deploy exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
  deployed.push(name);
}

console.log(
  `\n[email-pool] done: ${deployed.join(", ")}${
    dryRun ? " (dry run, nothing deployed)" : ""
  }`,
);
