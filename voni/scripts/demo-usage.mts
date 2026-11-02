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

import { USAGE, parseUsageArgs } from "./lib/usage/args";
import {
  DEFAULT_EVIDENCE_ROOT,
  DEFAULT_RUN_ROOT,
  resolveLatest,
  resolveRun,
} from "./lib/usage/evidence";
import { buildLedger, formatLedger } from "./lib/usage/ledger";
import { UsageCliError } from "./lib/usage/types";

export async function main(argv: readonly string[]): Promise<number> {
  let request;
  try {
    request = parseUsageArgs(argv);
  } catch (error) {
    if (error instanceof UsageCliError) {
      process.stderr.write(`demo:usage: ${error.message}\n\n${USAGE}\n`);
      return error.exitCode;
    }
    throw error;
  }

  if (request.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const options = {
    runRoot: resolve(request.runRoot ?? DEFAULT_RUN_ROOT),
    evidenceRoot: resolve(request.evidenceRoot ?? DEFAULT_EVIDENCE_ROOT),
  };

  try {
    const run =
      request.runId === undefined
        ? resolveLatest(options)
        : resolveRun(request.runId, options);
    const ledger = buildLedger(run);
    process.stdout.write(formatLedger(ledger));
    return 0;
  } catch (error) {
    if (error instanceof UsageCliError) {
      process.stderr.write(`demo:usage: REFUSED (${error.code}): ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`demo:usage: FAILED: ${(error as Error).message}\n`);
    return 1;
  }
}

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
