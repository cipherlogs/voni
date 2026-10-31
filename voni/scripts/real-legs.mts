/**
 * `npm run check:real-legs` — the key-gated real-legs command (ticket 22).
 *
 * The pure surface (skip decision, flags, targets, report) and the call's flow
 * live in `./lib/real-legs.ts`; this file is the operator join: argv,
 * environment, the shared envelope secret and the printed report.
 *
 * This command is never run by the pull-request workflow. CI runs its unit
 * tests (`scripts/real-legs.test.ts`) and nothing else, because a real legs
 * check needs real vendor keys, a real service and a real caller.
 */

import { pathToFileURL } from "node:url";

import { secret } from "../src/lib/env";
import {
  APP_PIPELINE_URL_ENV,
  BASE_URL_ENV,
  REAL_LEGS_USAGE,
  UsageError,
  failed,
  formatRealLegsReport,
  parseRealLegsArgs,
  realLegsExitCode,
  resolveTargets,
  runRealLegs,
  skipDecision,
  type RealLegsCheck,
  type RealLegsTarget,
} from "./lib/real-legs";

const ENVELOPE_SECRET_ENV = "VOICE_PIPELINE_ENVELOPE_SECRET";

function writeJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function report(checks: RealLegsCheck[], json: boolean, target?: RealLegsTarget): number {
  if (json) {
    writeJson({
      ok: realLegsExitCode(checks) === 0,
      ...(target ? { target } : {}),
      checks,
    });
  } else {
    if (target) {
      process.stdout.write(
        `real legs target: ${target.httpBase} (socket ${target.wsUrl})\n`,
      );
    }
    process.stdout.write(formatRealLegsReport(checks));
  }
  return realLegsExitCode(checks);
}

async function configuredBase(options: { baseUrl?: string; wsUrl?: string }): Promise<string> {
  if (options.baseUrl !== undefined) return options.baseUrl;
  // An explicit --ws-url names the whole target; a base inherited from the
  // environment would be a second, possibly different deployment.
  if (options.wsUrl !== undefined) return "";
  for (const name of [BASE_URL_ENV, APP_PIPELINE_URL_ENV]) {
    const value = await secret(name);
    if (value && value.trim() !== "") return value.trim();
  }
  return "";
}

export async function main(argv: string[]): Promise<number> {
  let options: ReturnType<typeof parseRealLegsArgs>;
  try {
    options = parseRealLegsArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`real-legs: ${error.message}\n\n${REAL_LEGS_USAGE}\n`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${REAL_LEGS_USAGE}\n`);
    return 0;
  }

  const decision = skipDecision(process.env);
  if (decision.skip) {
    if (options.json) {
      writeJson({ ok: true, skipped: true, reason: decision.reason });
    } else {
      process.stdout.write(`skipped: ${decision.reason}\n`);
    }
    return 0;
  }

  let target: RealLegsTarget;
  const baseUrl = await configuredBase(options);
  try {
    target = resolveTargets({ baseUrl, wsUrl: options.wsUrl });
  } catch (error) {
    const checks = [
      failed(
        "target",
        (error as { code?: string }).code ?? "target-invalid",
        (error as Error).message,
      ),
    ];
    return report(checks, options.json);
  }

  const envelopeSecret = await secret(ENVELOPE_SECRET_ENV);
  if (!envelopeSecret) {
    return report(
      [
        failed(
          "envelope secret",
          "envelope-secret-missing",
          `${ENVELOPE_SECRET_ENV} is not set; the app signs and the service verifies with the one shared value`,
        ),
      ],
      options.json,
      target,
    );
  }

  const checks = await runRealLegs(options, target, { env: process.env });
  return report(checks, options.json, target);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `real-legs: ${(error as Error).name}: ${(error as Error).message}\n`,
      );
      process.exitCode = 1;
    });
}
