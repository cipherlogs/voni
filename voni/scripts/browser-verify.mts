#!/usr/bin/env node
/**
 * The browser certification command.
 *
 *   cd voni && npm run demo:certify:browser -- --scenario golden-flow --target local
 *
 * One scenario, one real Chromium call, one certificate or one named refusal.
 * The command owns argv and the declared browser ceiling; everything testable
 * lives in `scripts/lib/browser-adapter/`.
 *
 * Exit codes are the spec's: 0 certified, 1 not-demo-ready, 2 bad input or a
 * missing evidence item. A fake stack is a named refusal, never a wait or a
 * pass.
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseReplayCommand } from "@/lib/demo/verification/cards";
import {
  CERTIFICATE_TARGETS,
  type CertificateTarget,
} from "@/lib/demo/verification/certificate";
import { loadContract } from "@/lib/demo/verification/contract";
import { LOCALES, type Locale } from "@/lib/demo/verification/scenarios";
import { loadEvaluators } from "@/lib/demo/verification/verdict";
import { runPlaywrightBrowserCall } from "./lib/browser-adapter/call";
import {
  BrowserAdapterError,
  defaultCapturesDir,
  runBrowserCertification,
  runReplayCommand,
  type BrowserRunResult,
} from "./lib/browser-adapter/index";
import { runProtocolDiagnosis } from "./lib/protocol-adapter/runner";
import { readBrowserE2eBudget, budgetVerdict } from "./browser-e2e-budget.mjs";

const USAGE = `usage: npm run demo:certify:browser -- --scenario <name> [options]

  --scenario NAME      the corpus scenario to certify (required)
  --target T          local | staging | production (default local)
  --locale L          en | es | fr | de | pt (must match the scenario)
  --app-url URL       the real app (default VONI_APP_URL)
  --pipeline-url URL  the real pipeline (default VOICE_PIPELINE_URL)
  --events-dir PATH   the pipeline's per-call trace directory
  --captures-dir PATH the app's gitignored .captures directory
  --run-root PATH     where this run's directory is written (default .demo-runs)
  --parity            also run the protocol adapter on the same scenario and compare
  --replay "CMD"      run the exact replay command a defect card carries
  --json              print one machine-readable result
  --help, -h          this text

Exit codes: 0 certified, 1 not-demo-ready, 2 bad input or missing evidence.
`;

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    target: { type: "string" },
    locale: { type: "string" },
    "app-url": { type: "string" },
    "pipeline-url": { type: "string" },
    "events-dir": { type: "string" },
    "captures-dir": { type: "string" },
    "run-root": { type: "string" },
    parity: { type: "boolean" },
    replay: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function usage(message: string): never {
  console.error(`demo:certify:browser: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const target = (values.target ?? "local") as CertificateTarget;
if (!(CERTIFICATE_TARGETS as readonly string[]).includes(target)) {
  usage(`unknown target "${values.target}"; expected ${CERTIFICATE_TARGETS.join(", ")}`);
}
const locale = values.locale as Locale | undefined;
if (locale !== undefined && !(LOCALES as readonly string[]).includes(locale)) {
  usage(`unknown Locale "${locale}"; expected ${LOCALES.join(", ")}`);
}

let scenarioName = values.scenario;
let replayCommand: string | null = null;
if (values.replay !== undefined) {
  if (scenarioName !== undefined) usage("--replay and --scenario are the same input; give one");
  try {
    const replay = parseReplayCommand(values.replay);
    scenarioName = replay.scenario;
    if (replay.target !== target) {
      usage(`the replay command runs target "${replay.target}", not "${target}"`);
    }
    replayCommand = values.replay;
  } catch (error) {
    usage(`the replay command is not the card's contract: ${(error as Error).message}`);
  }
}
if (scenarioName === undefined) usage("--scenario is required");

const budget = readBrowserE2eBudget({ repoRoot: REPO_ROOT });
const elapsedBudgetS = budget.status === "measured" ? budget.budgetS : null;
if (budget.status === "open") {
  console.error(`[browser] ${budget.blocker}`);
}

async function main(): Promise<number> {
  if (scenarioName === undefined) usage("--scenario is required");
  const certifiedScenario = scenarioName;
  const contract = await loadContract();
  const evaluators = await loadEvaluators(contract);
  // Every discovered evaluator names the one module a defect card points at.
  // The map is derived from the registry, never hand-listed, so a new family
  // file cannot forget its pointer.
  const modules = Object.fromEntries(
    evaluators
      .filter((evaluator) => typeof evaluator.modulePath === "string")
      .map((evaluator) => [
        evaluator.propertyId,
        [`voni/src/lib/demo/verification/verdict/evaluators/${evaluator.modulePath}`],
      ]),
  );
  const shared = {
    contract,
    evaluators,
    modules,
    env: process.env,
    appUrl: values["app-url"],
    pipelineUrl: values["pipeline-url"],
    eventsDir: values["events-dir"],
    capturesDir: values["captures-dir"] ?? defaultCapturesDir(),
    runRoot: values["run-root"],
    elapsedBudgetS,
    repoRoot: REPO_ROOT,
    call: (input: Parameters<typeof runPlaywrightBrowserCall>[0]) =>
      runPlaywrightBrowserCall(input),
  };

  let parityVerdict: Awaited<ReturnType<typeof runProtocolDiagnosis>>["verdict"] = null;
  let parityRunDir: string | null = null;
  let parityNote: string | null = null;
  if (values.parity === true) {
    // The protocol adapter runs first so one browser call is compared against
    // it. A refused protocol run is an unavailable comparison, never agreement.
    const protocol = await runProtocolDiagnosis({
      scenarioName: certifiedScenario,
      target,
      locale,
      contract,
      evaluators,
      env: process.env,
      targetUrl: values["pipeline-url"] ? { baseUrl: values["pipeline-url"] } : undefined,
      eventsDir: values["events-dir"],
      runRoot: values["run-root"],
      repoRoot: REPO_ROOT,
    });
    parityVerdict = protocol.verdict;
    parityRunDir = protocol.runDir;
    if (protocol.status === "refused") {
      parityNote =
        `parity unavailable: the protocol adapter refused (${protocol.unrun.join("; ")}); ` +
        "no agreement is claimed";
    }
  }

  const run: BrowserRunResult =
    replayCommand === null
      ? await runBrowserCertification({
          ...shared,
          scenarioName: certifiedScenario,
          target,
          locale,
          parityVerdict,
          parityRunDir,
          parityNote,
        })
      : await runReplayCommand(replayCommand, {
          ...shared,
          parityVerdict,
          parityRunDir,
          parityNote,
        });

  if (values.json === true) {
    console.log(JSON.stringify({ ...run, ceiling: budget }, null, 2));
  } else {
    console.log(`[browser] run ${run.runId} → ${run.status} (exit ${run.exitCode})`);
    console.log(
      `[browser] scenario ${run.scenario?.name ?? scenarioName} · ${run.locale} · ${run.target}`,
    );
    console.log(`[browser] artifacts ${run.runDir}`);
    if (run.certificateFile !== null) console.log(`[browser] certificate ${run.certificateFile}`);
    if (run.verdict !== null) console.log(`[browser] verdict ${run.verdict.detail}`);
    if (run.parity !== null) {
      console.log(
        `[browser] parity ${run.parity.agree ? "agree" : "DISAGREE"} ` +
          `(${run.parity.comparedPropertyIds.length} deterministic properties)`,
      );
      for (const item of run.parity.disagreements) {
        console.log(`  ${item.kind} ${item.propertyId ?? ""}: ${item.detail}`);
      }
    }
    if (run.unrun.length > 0) {
      console.log("[browser] unrun:");
      for (const line of run.unrun) console.log(`  - ${line}`);
    }
    if (run.call !== null) {
      console.log(`[browser] ${budgetVerdict({ elapsedMs: run.call.elapsedMs, budget }).line}`);
    }
  }
  return run.exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof BrowserAdapterError) {
    console.error(`[browser] REFUSED (${error.code}): ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(`[browser] FAILED: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
