/**
 * The `demo:usage` command's body, in a module a test can import.
 *
 * `scripts/demo-usage.mts` is the thin entry that runs this; keeping the body
 * here lets the command surface be tested without spawning a process.
 */

import { resolve } from "node:path";

import { USAGE, parseUsageArgs } from "./args";
import {
  DEFAULT_EVIDENCE_ROOT,
  DEFAULT_RUN_ROOT,
  resolveLatest,
  resolveRun,
} from "./evidence";
import { buildLedger, formatLedger } from "./ledger";
import { UsageCliError } from "./types";

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
