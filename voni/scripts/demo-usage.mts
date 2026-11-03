#!/usr/bin/env node
/**
 * `demo:usage` — one run's vendor usage, priced from the run's own rows.
 *
 *   npm run demo:usage -- --latest
 *   npm run demo:usage -- --run <runId>
 *
 * The run id names a local adapter directory under `voni/.demo-runs/` or a
 * committed certificate under `voni/evidence/certificates/`. The ledger prints
 * Meta and AssemblyAI quantities, USD per leg and vendor, a per-scenario and
 * per-call breakdown, and a named unmeasured section. It never estimates a
 * leg and never presents an unmeasured leg as $0.
 *
 * Exit codes: 0 the ledger printed, 2 bad input or missing evidence.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./lib/usage/main";

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`demo:usage: FAILED: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
