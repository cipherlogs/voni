#!/usr/bin/env node
/**
 * `demo:verify` — one command answers "is the demo ready".
 *
 *   npm run demo:verify -- --target local --fast
 *   npm run demo:verify -- --scenario <name> --target local --diagnose
 *   npm run demo:verify -- --full          (English; a non-English full is refused)
 *
 * The logic lives in `scripts/lib/verify-cli/` so tests drive `main(argv)`
 * without spawning a process. This file owns only the wiring: the real browser
 * and protocol adapters, the machine-wide timing lock, and writing the one
 * certificate a full run issues.
 *
 * Exit codes: 0 certified, 1 not-demo-ready, 2 bad input or missing evidence,
 * 3 pending human panel.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCodeFingerprint } from "../src/lib/demo/scoreboard";
import { serializeCertificate } from "../src/lib/demo/verification/certificate";
import { loadContract } from "../src/lib/demo/verification/contract";
import { loadCorpus } from "../src/lib/demo/verification/scenarios";
import { loadEvaluators } from "../src/lib/demo/verification/verdict";
import { acquireTimingLock } from "../src/lib/demo/timing-lock";
import {
  readVendorBuilds,
} from "./lib/protocol-adapter/refusals";
import { runProtocolDiagnosis } from "./lib/protocol-adapter/runner";
import { runBrowserCertification, type BrowserRunInput } from "./lib/browser-adapter/runner";
import { defaultCapturesDir } from "./lib/browser-adapter/runner";
import {
  VERIFY_USAGE,
  VerifyCliError,
  parseVerifyArgs,
  runVerify,
  type VerifyDeps,
  type VerifyResult,
} from "./lib/verify-cli";
import { readBrowserE2eBudget } from "./browser-e2e-budget.mjs";
import { adapterRefusalFor } from "./lib/verify-cli/adapter-refusal";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function budgetCeiling(): number | null {
  const budget = readBrowserE2eBudget({ repoRoot: REPO_ROOT });
  if (budget.status === "open") {
    process.stderr.write(`[verify] ${budget.blocker}\n`);
    return null;
  }
  return budget.budgetS;
}

function realDeps(): VerifyDeps {
  const elapsedBudgetS = budgetCeiling();
  // One contract and one evaluator set per command: a full run makes hundreds
  // of calls, and discovering the registry again per call would be pure waste.
  let contractPromise: ReturnType<typeof loadContract> | null = null;
  let evaluatorsPromise: ReturnType<typeof loadEvaluators> | null = null;
  const sharedContract = (): ReturnType<typeof loadContract> =>
    (contractPromise ??= loadContract());
  const sharedEvaluators = (
    contract: Awaited<ReturnType<typeof loadContract>>,
  ): ReturnType<typeof loadEvaluators> => (evaluatorsPromise ??= loadEvaluators(contract));

  return {
    env: process.env,
    loadContract: sharedContract,
    loadCorpus: (options) =>
      loadCorpus({
        knownProperties: options.knownProperties,
        dir: options.dir,
      }),
    loadEvaluators: sharedEvaluators,
    readVendorBuilds,
    acquireLock: (options) => acquireTimingLock(options),
    readCodeFingerprint,
    diagnose: async ({ request }) => {
      const result = await runProtocolDiagnosis({
        scenarioName: request.scenario as string,
        target: request.target,
        ...(request.locale === undefined ? {} : { locale: request.locale }),
        ...(request.corpusDir === undefined ? {} : { corpusDir: request.corpusDir }),
        env: process.env,
        ...(request.pipelineUrl === undefined
          ? {}
          : { targetUrl: { baseUrl: request.pipelineUrl } }),
        ...(request.eventsDir === undefined ? {} : { eventsDir: request.eventsDir }),
        ...(request.runRoot === undefined ? {} : { runRoot: request.runRoot }),
        repoRoot: REPO_ROOT,
      });
      return {
        status: result.status,
        exitCode: result.exitCode,
        runId: result.runId,
        runDir: result.runDir,
        refusal: adapterRefusalFor({
          refused: result.status === "refused",
          refusal: result.refusal,
          unrun: result.unrun,
          fallback: "the protocol adapter refused without a reason",
        }),
      };
    },
    runScenario: async (input) => {
      const contract = await sharedContract();
      const runInput: BrowserRunInput = {
        scenarioName: input.scenario,
        target: input.target,
        locale: input.locale,
        contract,
        evaluators: await sharedEvaluators(contract),
        plan: {
          mode: input.request.mode === "diagnose" ? "diagnose" : input.request.mode,
          repetitions: input.request.mode === "full" ? 3 : 1,
        },
        certificate: "withhold",
        env: process.env,
        ...(input.request.appUrl === undefined ? {} : { appUrl: input.request.appUrl }),
        ...(input.request.pipelineUrl === undefined
          ? {}
          : { pipelineUrl: input.request.pipelineUrl }),
        ...(input.request.eventsDir === undefined
          ? {}
          : { eventsDir: input.request.eventsDir }),
        ...(input.request.runRoot === undefined ? {} : { runRoot: input.request.runRoot }),
        capturesDir: input.request.capturesDir ?? defaultCapturesDir(),
        ...(input.request.corpusDir === undefined
          ? {}
          : { corpusDir: input.request.corpusDir }),
        ...(input.request.vendorBuildsPath === undefined
          ? {}
          : { vendorBuildsPath: input.request.vendorBuildsPath }),
        elapsedBudgetS,
        repoRoot: REPO_ROOT,
      };
      const result = await runBrowserCertification(runInput);
      return {
        refusal: adapterRefusalFor({
          refused: result.exitCode === 2,
          refusal: result.refusal,
          unrun: result.unrun,
          fallback: "the browser adapter refused without a reason",
        }),
        attempt: result.attempt,
        eligibility: result.eligibility,
        pipelineImage: result.pipelineImage,
      };
    },
  };
}

function writeCertificate(result: VerifyResult): void {
  if (result.certificate === null || result.certificatePath === null) return;
  mkdirSync(dirname(result.certificatePath), { recursive: true });
  const temporary = `${result.certificatePath}.tmp-${process.pid}`;
  writeFileSync(temporary, serializeCertificate(result.certificate), "utf8");
  renameSync(temporary, result.certificatePath);
}

function print(result: VerifyResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [
    `[verify] ${result.mode} · target ${result.target}` +
      (result.locale === null ? "" : ` · ${result.locale}`) +
      (result.scenario === null ? "" : ` · ${result.scenario}`) +
      ` → ${result.status} (exit ${result.exitCode})`,
  ];
  if (result.runId !== null) lines.push(`[verify] run ${result.runId}`);
  if (result.calls > 0) lines.push(`[verify] calls ${result.calls}`);
  if (result.certificatePath !== null) lines.push(`[verify] certificate ${result.certificatePath}`);
  if (result.detail !== "" && result.status !== "refused") {
    lines.push(`[verify] ${result.detail}`);
  }
  if (result.refusals.length > 0) {
    lines.push("[verify] refused:");
    for (const line of result.refusals) lines.push(`  - ${line}`);
  }
  if (result.unrun.length > 0) {
    lines.push("[verify] unrun:");
    for (const line of result.unrun) lines.push(`  - ${line}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function main(argv: readonly string[]): Promise<number> {
  let request;
  try {
    request = parseVerifyArgs(argv);
  } catch (error) {
    if (error instanceof VerifyCliError) {
      process.stderr.write(`demo:verify: ${error.message}\n\n${VERIFY_USAGE}\n`);
      return error.exitCode;
    }
    throw error;
  }

  if (request.help) {
    process.stdout.write(`${VERIFY_USAGE}\n`);
    return 0;
  }

  const result = await runVerify(request, realDeps());
  writeCertificate(result);
  print(result, request.json);
  return result.exitCode;
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
      process.stderr.write(`demo:verify: FAILED: ${(error as Error).message}\n`);
      process.exitCode = 2;
    });
}
