/**
 * The browser adapter runner: one scenario, one certifying call, one verdict,
 * one certificate or one named refusal.
 *
 * Order of operations, and why it is this order:
 *
 * 1. **Preflight.** A fake pipeline, a test build, a missing key, corpus,
 *    scenario, vendor build, soundscape or capture sink is refused by name with
 *    exit 2, before Chromium opens.
 * 2. **One call.** The browser harness runs exactly once. There is no retry: a
 *    failure is evidence, not a reason to try again.
 * 3. **Evidence.** The delivered WAV, the browser marks, the trace, the end
 *    document, the tool rows and the priced row are read from the call and
 *    copied into the run directory. Cost is copied, never recomputed.
 * 4. **Verdict.** The one evidence bundle is judged by the real verdict engine
 *    and every declared evaluator. No evaluator means the property fails; this
 *    adapter has no power to stub a pass.
 * 5. **Certificate.** A completed run writes a certificate through ticket 08's
 *    builder. Only `certified` exits 0; every other verdict exits 1.
 * 6. **Parity.** When the CLI supplied the protocol adapter's verdict, the two
 *    are compared and a disagreement is named on the run.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "One seam, two adapters",
 * "Targets, runs and cadence" and "The certifying test is the visitor's path".
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultEventsDir } from "../adapter-evidence";
import { readCallOutcome } from "./call-outcome";
import { readCodeFingerprint } from "@/lib/demo/scoreboard";
import { loadContract, type Contract } from "@/lib/demo/verification/contract";
import { parseReplayCommand, renderDefectCards } from "@/lib/demo/verification/cards";
import {
  compareAdapterVerdicts,
  parityLine,
  snapshotVerdict,
} from "@/lib/demo/verification/adapters";
import {
  buildCertificate,
  FULL_SCOPE,
  OPEN_RESIDUAL_RISK_IDS,
  type Certificate,
} from "@/lib/demo/verification/certificate";
import {
  DEFAULT_CORPUS_DIR,
  scenarioFacts,
  type CorpusReference,
  type LoadedScenario,
  type Locale,
} from "@/lib/demo/verification/scenarios";
import {
  evaluateScenarios,
  judgeRun,
  loadEvaluators,
  type PropertyEvaluator,
  type RunVerdict,
  type ScenarioAttempt,
} from "@/lib/demo/verification/verdict";
import type { CardTarget } from "@/lib/demo/verification/cards";
import { readDemoCallTag, readDemoToolLog } from "@/lib/demo/tool-log-store";
import {
  countThreadReplies,
  findTaggedMessage,
} from "@/lib/demo/verification/tools/inbox";
import {
  collectToolEvidence,
  type ToolEvidenceCollection,
} from "../protocol-adapter/tool-evidence";
import { QUIET_SOUNDSCAPE } from "../protocol-adapter/faults";

import { runPlaywrightBrowserCall } from "./call";
import { BrowserAdapterError } from "./errors";
import {
  assembleBrowserEvidence,
  buildCards,
  cardInputs,
  requireSafeId,
  runDirectory,
  writeJson,
} from "./evidence";
import {
  defaultVendorBuildsPath,
  preflightBrowserRun,
  readVendorBuilds,
  refusalCodeFor,
} from "./refusals";
import {
  BROWSER_ADAPTER,
  BROWSER_RUN_SCHEMA_VERSION,
  DEFAULT_BROWSER_RUN_ROOT,
  type BrowserCallAdapter,
  type BrowserCallRecord,
  type BrowserCardGap,
  type BrowserParityRecord,
  type BrowserRunRecord,
  type BrowserRunResult,
  type BrowserRunStatus,
  type BrowserTargetLabel,
  type MissingItem,
  type VendorBuildRecord,
} from "./types";

export type BrowserRunInput = {
  readonly scenarioName: string;
  readonly target: BrowserTargetLabel;
  readonly locale?: Locale;
  /** Defaults to the committed corpus root (ticket 12 fills it). */
  readonly corpusDir?: string | URL;
  /** Defaults to the live contract registry. */
  readonly contract?: Contract;
  /** Defaults to the discovered evaluator modules. */
  readonly evaluators?: readonly PropertyEvaluator[];
  /** Defaults to the real Playwright harness; tests inject a fake call. */
  readonly call?: BrowserCallAdapter;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly appUrl?: string;
  readonly pipelineUrl?: string;
  readonly runRoot?: string;
  /** Defaults to the local pipeline's `.events` directory. */
  readonly eventsDir?: string;
  /** Defaults to the app's gitignored `.captures` directory. */
  readonly capturesDir?: string;
  readonly vendorBuilds?: VendorBuildRecord | null;
  readonly vendorBuildsPath?: string;
  readonly soundscapes?: Readonly<Record<string, Uint8Array>>;
  readonly modules?: Readonly<Record<string, readonly string[]>>;
  /** Injected by tests; production reads the app DB and the real inbox. */
  readonly toolEvidence?: ToolEvidenceCollection;
  readonly repoRoot?: string;
  readonly runId?: string;
  readonly timeoutMs?: number;
  /** The network seam; tests answer the stack probe without a server. */
  readonly stackProbe?: import("./types").BrowserStackProbe;
  /** The declared browser ceiling in seconds; null means the record is open. */
  readonly elapsedBudgetS?: number | null;
  /** The protocol adapter's verdict for the same scenario, when parity was asked for. */
  readonly parityVerdict?: RunVerdict | null;
  readonly parityRunDir?: string | null;
  /** Why parity is unavailable, when the protocol adapter refused. */
  readonly parityNote?: string | null;
  /** The certificate plan; a diagnose run is one repetition. */
  readonly plan?: { readonly mode: "diagnose" | "fast" | "nightly" | "full" | "cutover"; readonly repetitions: number };
  /**
   * Whether this call writes its own certificate. A single-scenario certifying
   * run issues one; a multi-scenario caller withholds it because the run owns
   * the one certificate, and the call's attempt is judged with the rest.
   */
  readonly certificate?: "issue" | "withhold";
};

const VONI_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** The app's gitignored dev capture directory, relative to `voni/`. */
export function defaultCapturesDir(): string {
  return join(VONI_ROOT, ".captures");
}

function defaultAppUrl(env: Readonly<Record<string, string | undefined>>): string {
  return env.VONI_APP_URL?.trim() || "";
}

function defaultPipelineUrl(env: Readonly<Record<string, string | undefined>>): string {
  return env.VOICE_PIPELINE_URL?.trim() || env.VOICE_PIPELINE_SERVICE_URL?.trim() || "";
}

function budgetOf(
  measuredMs: number | null,
  ceilingS: number | null,
): BrowserRunRecord["browserBudget"] {
  if (ceilingS === null) {
    return {
      bound: "ci.browser_e2e_budget_s",
      ceilingS: null,
      measuredMs,
      status: "unset",
      line:
        "bound \"ci.browser_e2e_budget_s\" is unset: the run made no browser runtime claim " +
        "(never an invented ceiling)",
    };
  }
  if (measuredMs === null) {
    // No elapsed time was measured, so the ceiling was never compared. This
    // is INFO, never `within`: an unmeasured budget cannot read as a pass.
    return {
      bound: "ci.browser_e2e_budget_s",
      ceilingS,
      measuredMs: null,
      status: "unknown",
      line:
        `the browser run's elapsed time was not measured against the declared ` +
        `${ceilingS * 1000}ms ceiling; the budget is unknown (INFO, never within)`,
    };
  }
  const over = measuredMs > ceilingS * 1000;
  return {
    bound: "ci.browser_e2e_budget_s",
    ceilingS,
    measuredMs,
    status: over ? "over" : "within",
    line:
      `browser run ${measuredMs}ms ${over ? ">" : "≤"} ${ceilingS * 1000}ms ` +
      `(${over ? "OVER" : "within"} the declared ceiling)`,
  };
}

function measuredCost(bundle: { readonly cost?: Record<string, unknown> }): number {
  const cost = bundle.cost;
  if (cost === undefined) {
    throw new BrowserAdapterError(
      "cost-missing",
      "the call wrote no cost.priced row; a certificate carries the call's own measured " +
        "cost and the runner never recomputes it",
    );
  }
  if (cost.measured !== true) {
    throw new BrowserAdapterError(
      "cost-missing",
      `the cost.priced row is unmeasured (${String(cost.unmeasuredReason ?? "no reason recorded")}); ` +
        "a certificate cannot record a price the table never gave",
    );
  }
  const total = cost.totalUsd;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    throw new BrowserAdapterError(
      "cost-missing",
      `the cost.priced row reports measured=true but totalUsd=${JSON.stringify(total)}; ` +
        "a certificate needs the priced total",
    );
  }
  return total;
}

/** Write a refused run's record, then return it. A refusal is still evidence. */
async function refused(
  runId: string,
  runDir: string,
  error: BrowserAdapterError,
  context: {
    readonly target: BrowserTargetLabel;
    readonly locale: Locale;
    readonly scenarioName: string;
    readonly corpus: CorpusReference | null;
    readonly scenarioFingerprint: string | null;
    readonly codeFingerprint: BrowserRunRecord["codeFingerprint"];
    readonly startedAt: string;
    readonly call: BrowserCallRecord | null;
    readonly budget: BrowserRunRecord["browserBudget"];
    readonly previous: readonly string[];
    /** The call's priced row when it served one; null is unmeasured. */
    readonly cost?: Record<string, unknown> | null;
  },
): Promise<BrowserRunResult> {
  const record: BrowserRunRecord = {
    schemaVersion: BROWSER_RUN_SCHEMA_VERSION,
    runId,
    adapter: BROWSER_ADAPTER,
    target: context.target,
    scenario: context.scenarioName,
    locale: context.locale,
    corpus: context.corpus,
    scenarioFingerprint: context.scenarioFingerprint,
    codeFingerprint: context.codeFingerprint,
    certifiable: true,
    startedAt: context.startedAt,
    endedAt: new Date().toISOString(),
    status: "refused",
    call: context.call,
    certification: "withheld",
    certificationReason: error.message,
    certificate: null,
    verdict: null,
    cards: { file: null, count: 0, gaps: [] },
    browserBudget: context.budget,
    unrun: [
      ...context.previous,
      ...(context.budget.status === "unknown" ? [context.budget.line] : []),
      error.message,
    ],
    parity: null,
    refusal: { code: error.code, message: error.message },
  };
  await mkdir(runDir, { recursive: true });
  await writeJson(join(runDir, "run.json"), record);
  return {
    runId,
    runDir,
    status: "refused",
    attempt: null,
    eligibility: null,
    pipelineImage: null,
    cost: context.cost ?? null,
    exitCode: 2,
    verdict: null,
    certificateFile: null,
    cards: [],
    cardGaps: [],
    call: context.call,
    unrun: record.unrun,
    corpus: context.corpus,
    scenario: null,
    target: context.target,
    locale: context.locale,
    parity: null,
    refusal: { code: error.code, message: error.message },
  };
}

/**
 * Run one certification. `exitCode` is 0 only for a certified run, 1 for a
 * completed run with findings and 2 for a named refusal.
 */
export async function runBrowserCertification(
  input: BrowserRunInput,
): Promise<BrowserRunResult> {
  const env = input.env ?? process.env;
  const startedAt = new Date().toISOString();
  const runId = requireSafeId(
    input.runId ?? `browser-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    "run id",
  );
  const runDir = runDirectory(input.runRoot ?? DEFAULT_BROWSER_RUN_ROOT, runId);
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const locale = input.locale ?? "en";
  const codeFingerprint = readCodeFingerprint(repoRoot);
  const budget = budgetOf(null, input.elapsedBudgetS ?? null);
  const unrunBefore: string[] = [];

  if (codeFingerprint === null) {
    return refused(
      runId,
      runDir,
      new BrowserAdapterError(
        "evidence-unreachable",
        "the repository has no HEAD; a certificate must bind to the code it ran and never " +
          "to a blank fingerprint",
      ),
      {
        target: input.target,
        locale,
        scenarioName: input.scenarioName,
        corpus: null,
        scenarioFingerprint: null,
        codeFingerprint,
        startedAt,
        call: null,
        budget,
        previous: [],
      },
    );
  }

  const contract = input.contract ?? (await loadContract());
  const evaluators = input.evaluators ?? (await loadEvaluators(contract));
  const vendorBuildsPath = input.vendorBuildsPath ?? defaultVendorBuildsPath();
  let vendorBuilds = input.vendorBuilds;
  if (vendorBuilds === undefined) {
    vendorBuilds = await readVendorBuilds(vendorBuildsPath);
  }

  let preflightAnswer;
  try {
    preflightAnswer = await preflightBrowserRun({
      scenarioName: input.scenarioName,
      target: input.target,
      locale: input.locale,
      corpusDir: input.corpusDir ?? DEFAULT_CORPUS_DIR,
      knownProperties: new Set(contract.properties.map((property) => property.id)),
      env,
      appUrl: input.appUrl ?? defaultAppUrl(env),
      pipelineUrl: input.pipelineUrl ?? defaultPipelineUrl(env),
      vendorBuilds,
      vendorBuildsPath,
      soundscapes: input.soundscapes ?? {},
      ...(input.stackProbe === undefined ? {} : { probe: input.stackProbe }),
    });
  } catch (error) {
    const refusedError =
      error instanceof BrowserAdapterError
        ? error
        : new BrowserAdapterError("corpus-refused", String(error));
    return refused(runId, runDir, refusedError, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: null,
      scenarioFingerprint: null,
      codeFingerprint,
      startedAt,
      call: null,
      budget,
      previous: [],
    });
  }

  if (!preflightAnswer.ok) {
    const missing: readonly MissingItem[] = preflightAnswer.missing;
    const error = new BrowserAdapterError(
      refusalCodeFor(missing),
      `the certifying browser run cannot start; missing: ${missing
        .map((item) => `${item.item} (${item.detail})`)
        .join("; ")}`,
      missing,
    );
    return refused(runId, runDir, error, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: null,
      scenarioFingerprint: null,
      codeFingerprint,
      startedAt,
      call: null,
      budget,
      previous: [],
    });
  }

  const { scenario, corpus, target } = preflightAnswer;

  // A held-out scenario runs in a full certification and nowhere else. The
  // multi-call caller marks that by withholding each call's certificate (the
  // run owns the one certificate); a single-scenario command issues one, so a
  // sealed scenario there is still refused (RR-07).
  const fullCertification =
    input.plan?.mode === "full" && (input.certificate ?? "issue") === "withhold";
  if (scenario.heldOut && !fullCertification) {
    const error = new BrowserAdapterError(
      "corpus-refused",
      `scenario "${scenario.name}" is held out; a held-out scenario runs only in a full ` +
        "certification, and this run is not one (RR-07)",
    );
    return refused(runId, runDir, error, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: { version: corpus.version, sha256: corpus.fingerprint },
      scenarioFingerprint: scenario.fingerprint,
      codeFingerprint,
      startedAt,
      call: null,
      budget,
      previous: [],
    });
  }

  const callIdDir = join(runDir, "calls");
  await mkdir(callIdDir, { recursive: true });

  const callAdapter: BrowserCallAdapter =
    input.call ?? ((callInput) => runPlaywrightBrowserCall(callInput));

  let call;
  try {
    call = await callAdapter({
      scenario,
      target,
      capturesDir: input.capturesDir ?? defaultCapturesDir(),
      eventsDir: input.eventsDir ?? defaultEventsDir(env),
      runDir,
      elapsedBudgetS: input.elapsedBudgetS ?? null,
      env,
      soundscapePcm:
        scenario.soundscape.id === QUIET_SOUNDSCAPE
          ? null
          : (input.soundscapes ?? {})[scenario.soundscape.id] ?? null,
      ...(scenario.soundscape.levelDb === undefined
        ? {}
        : { soundscapeLevelDb: scenario.soundscape.levelDb }),
    });
  } catch (error) {
    const refusedError =
      error instanceof BrowserAdapterError
        ? error
        : new BrowserAdapterError(
            "call-refused",
            `the browser call failed: ${(error as Error).message}`,
          );
    return refused(runId, runDir, refusedError, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: { version: corpus.version, sha256: corpus.fingerprint },
      scenarioFingerprint: scenario.fingerprint,
      codeFingerprint,
      startedAt,
      call: null,
      budget: budgetOf(null, input.elapsedBudgetS ?? null),
      previous: [],
    });
  }

  if (call.triggerPlan.unresolved.length > 0) {
    const unresolved =
      `the browser call did not resolve ${call.triggerPlan.unresolved.length} caller trigger(s): ` +
      call.triggerPlan.unresolved
        .map((item) => `step ${item.step} "${item.take}" (${item.trigger}): ${item.reason}`)
        .join("; ");
    // A trigger that never resolved is only a result if the call existed. A
    // call that died in the opening handshake measured nothing, so it is
    // re-made once under the no-evidence amendment instead of being judged.
    const outcome = readCallOutcome({
      endPath: call.endPath,
      eventsDir: input.eventsDir ?? defaultEventsDir(env),
      callId: call.callId,
    });
    if (outcome.kind === "no-session") {
      const closed = new BrowserAdapterError(
        "call-not-opened",
        `${unresolved}; ${outcome.detail}`,
      );
      return refused(runId, runDir, closed, {
        target: input.target,
        locale,
        scenarioName: input.scenarioName,
        corpus: { version: corpus.version, sha256: corpus.fingerprint },
        scenarioFingerprint: scenario.fingerprint,
        codeFingerprint,
        startedAt,
        call: null,
        budget: budgetOf(call.elapsedMs, input.elapsedBudgetS ?? null),
        previous: [],
      });
    }
    const error = new BrowserAdapterError(
      "trigger-unresolved",
      `the browser call did not resolve ${call.triggerPlan.unresolved.length} caller trigger(s): ` +
        call.triggerPlan.unresolved
          .map((item) => `step ${item.step} "${item.take}" (${item.trigger}): ${item.reason}`)
          .join("; "),
    );
    return refused(runId, runDir, error, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: { version: corpus.version, sha256: corpus.fingerprint },
      scenarioFingerprint: scenario.fingerprint,
      codeFingerprint,
      startedAt,
      call: null,
      budget: budgetOf(call.elapsedMs, input.elapsedBudgetS ?? null),
      previous: [],
    });
  }

  const callDir = join(callIdDir, requireSafeId(call.callId ?? "unresolved", "call id"));
  const toolEvidence =
    input.toolEvidence ??
    (call.callId === null
      ? {
          log: [],
          delivery: null,
          gap: "the browser call has no call id, so the demo tool log cannot be read",
        }
      : await collectToolEvidence({
          callId: call.callId,
          env,
          deps: {
            readLog: readDemoToolLog,
            readTag: readDemoCallTag,
            findTaggedMessage,
            countThreadReplies,
          },
        }));
  let assembled;
  let callRecord;
  try {
    ({ assembled, record: callRecord } = await assembleBrowserEvidence({
      call,
      scenario,
      target: input.target,
      eventsDir: input.eventsDir ?? defaultEventsDir(env),
      callDir,
      toolEvidence,
    }));
  } catch (error) {
    const refusedError =
      error instanceof BrowserAdapterError
        ? error
        : new BrowserAdapterError("trace-missing", String(error));
    return refused(runId, runDir, refusedError, {
      target: input.target,
      locale,
      scenarioName: input.scenarioName,
      corpus: { version: corpus.version, sha256: corpus.fingerprint },
      scenarioFingerprint: scenario.fingerprint,
      codeFingerprint,
      startedAt,
      call: null,
      budget: budgetOf(call.elapsedMs, input.elapsedBudgetS ?? null),
      previous: [],
    });
  }

  const attempt: ScenarioAttempt = {
    scenario: scenario.name,
    repetition: 1,
    locale: scenario.locale,
    target: input.target,
    // The scenario declares what it measures; an evaluator for a property it
    // never cites is not run against this call. The authored caller words are
    // ground truth for an exactness bar, not a measurement.
    expectedProperties: scenario.expectedProperties,
    evidence: assembled.bundle,
    facts: scenarioFacts(scenario),
  };
  const evidence = await evaluateScenarios({
    contract,
    evaluators,
    attempts: [attempt],
  });
  const judged = judgeRun({
    runId,
    contract,
    evidence,
    calls: [assembled.eligibility],
  });

  // The browser ceiling is a run-level claim, not a property: an over-budget
  // run is never certified even when every property passed.
  const browserBudget = budgetOf(call.elapsedMs, input.elapsedBudgetS ?? null);
  const runFailures = [...judged.failures];
  const budgetFailure =
    browserBudget.status === "over"
      ? `${browserBudget.line}; an over-budget browser run cannot certify`
      : null;
  if (budgetFailure !== null) runFailures.push(budgetFailure);

  // Parity is a run-level claim too: a protocol adapter that passes what the
  // browser failed makes the certificate false, whatever the browser saw.
  let parity: BrowserParityRecord | null = null;
  if (input.parityNote !== undefined && input.parityNote !== null) {
    unrunBefore.push(input.parityNote);
  }
  if (input.parityVerdict !== undefined && input.parityVerdict !== null) {
    const report = compareAdapterVerdicts(
      snapshotVerdict("browser", judged, scenario.name),
      snapshotVerdict("protocol", input.parityVerdict, scenario.name),
    );
    parity = {
      agree: report.agree,
      scenario: report.scenario,
      comparedPropertyIds: report.comparedPropertyIds,
      disagreements: report.disagreements.map((item) => ({
        kind: item.kind,
        propertyId: item.propertyId,
        detail: item.detail,
      })),
      notCompared: report.notCompared,
      protocolRunDir: input.parityRunDir ?? null,
    };
    if (!report.agree) {
      runFailures.push(parityLine(report));
    } else {
      unrunBefore.push(parityLine(report));
    }
  }

  const verdict: RunVerdict =
    runFailures.length === judged.failures.length
      ? judged
      : {
          ...judged,
          verdict: judged.verdict === "ineligible" ? "ineligible" : "not-demo-ready",
          certifiable:
            judged.verdict === "certified" && runFailures.length === 0
              ? true
              : false,
          failures: runFailures,
          detail:
            judged.detail +
            (runFailures.length === judged.failures.length
              ? ""
              : `; ${runFailures.slice(judged.failures.length).join("; ")}`),
        };

  const verdictFile = join(runDir, "verdict.json");
  await writeJson(verdictFile, verdict);

  const cardData = cardInputs({
    runId,
    verdict,
    target: input.target,
    scenario,
    record: callRecord,
    bundle: assembled.bundle,
    modules: input.modules ?? {},
    repoRoot,
  });
  // A partial run (some properties have no evaluator yet) still produces the
  // cards its evidence can support. A failure with no attribution or no module
  // pointer stays a named gap; it must not suppress the cards that are
  // provable, or the visitor-facing bug has no triage pointer at all.
  const attributable = new Set(cardData.attributions.map((item) => item.propertyId));
  const cardVerdict: RunVerdict = {
    ...verdict,
    properties: verdict.properties.filter(
      (property) => property.status !== "FAIL" || attributable.has(property.propertyId),
    ),
  };
  const cardBuild =
    cardData.attributions.length === 0
      ? { cards: [], gaps: [] }
      : buildCards({
          runId,
          verdict: cardVerdict,
          target: input.target,
          calls: cardData.call === null ? [] : [cardData.call],
          attributions: cardData.attributions,
          modules: input.modules ?? {},
          repoRoot,
        });
  const allCardGaps: BrowserCardGap[] = [...cardData.gaps, ...cardBuild.gaps];
  const cards = cardBuild.cards;
  let cardsFile: string | null = null;
  if (cards.length > 0) {
    cardsFile = join(runDir, "cards.json");
    await writeJson(cardsFile, cards);
    await writeJson(join(runDir, "cards.md"), renderDefectCards(cards));
  }

  let certificate: Certificate | null = null;
  let certificateFile: string | null = null;
  let certificationReason: string | null = null;
  const withholdCertificate = input.certificate === "withhold";
  try {
    if (withholdCertificate) {
      throw new BrowserAdapterError(
        "certificate-refused",
        "the caller withheld this call's certificate: a multi-scenario run owns the run's " +
          "one certificate, and this call's attempt is judged with the rest",
      );
    }
    const usd = measuredCost(assembled.bundle);
    certificate = buildCertificate({
      contract,
      run: verdict,
      target: input.target,
      // This adapter issues a single-scenario claim; it declares every Locale so
      // the four it did not run are named gaps, never silently dropped. A
      // scoped certificate comes from the plan-aware `demo:verify` CLI.
      scope: FULL_SCOPE,
      plan: input.plan ?? { mode: "diagnose", repetitions: 1 },
      corpus: {
        version: corpus.version,
        fingerprint: corpus.fingerprint,
        scenarios: corpus.scenarios.map((entry) => ({
          name: entry.name,
          locale: entry.locale,
          heldOut: entry.heldOut,
          class: entry.class,
        })),
      },
      attempts: [
        {
          scenario: scenario.name,
          locale: scenario.locale,
          repetition: 1,
          callId: callRecord.callId,
        },
      ],
      codeFingerprint,
      appBuild: codeFingerprint.head,
      pipelineImage: preflightAnswer.pipelineBuild,
      vendorBuilds: preflightAnswer.vendorBuilds,
      cost: { usd, callCount: 1 },
      residualRiskIds: [...OPEN_RESIDUAL_RISK_IDS],
      panel: null,
    });
    certificateFile = join(runDir, "certificate.json");
    await writeJson(certificateFile, certificate);
  } catch (error) {
    // A certificate that cannot be built is a withheld claim, not a green and
    // not a lost run: the verdict and cards stay, and the reason is named.
    certificationReason =
      error instanceof BrowserAdapterError
        ? `${error.code}: ${error.message}`
        : `certificate-refused: ${(error as Error).message}`;
  }

  const unrun: string[] = [];
  if (evaluators.length === 0) {
    unrun.push(
      `no evaluator modules are installed; ${contract.properties.length} properties fail with ` +
        "no-evaluator (tickets 13–22, 26)",
    );
  } else if (evaluators.length < contract.properties.length) {
    unrun.push(
      `${contract.properties.length - evaluators.length} properties have no evaluator and fail closed`,
    );
  }
  const nonDeterministic = contract.properties.filter(
    (property) => property.kind !== "deterministic",
  ).length;
  if (nonDeterministic > 0 && (input.plan?.repetitions ?? 1) < 3) {
    unrun.push(
      `${nonDeterministic} timing/behaviour properties need 3 repetitions; a diagnose run ` +
        "measures 1 and fails their repetition plan rather than borrowing a pass",
    );
  }
  unrun.push(...unrunBefore);
  if (browserBudget.status === "unknown") unrun.push(browserBudget.line);
  unrun.push(...assembled.gaps);
  if (certificationReason !== null) {
    unrun.push(`certificate withheld: ${certificationReason}`);
  }
  if (callRecord.error !== null) unrun.push(`browser harness: ${callRecord.error}`);
  for (const gap of allCardGaps) {
    unrun.push(`defect card for ${gap.propertyId} withheld (${gap.code}): ${gap.detail}`);
  }

  const certificateVerdict = certificate?.verdict ?? null;
  const runStatus: BrowserRunStatus =
    certificate === null
      ? verdict.verdict === "ineligible"
        ? "ineligible"
        : verdict.verdict === "certified" && withholdCertificate
          ? "certified"
          : "not-demo-ready"
      : certificateVerdict === "certified"
        ? "certified"
        : certificateVerdict === "pending-human"
          ? "pending-human"
          : certificateVerdict === "ineligible"
            ? "ineligible"
            : "not-demo-ready";
  const exitCode: BrowserRunResult["exitCode"] =
    certificate?.pass === true
      ? 0
      : certificateVerdict === "pending-human"
        ? 3
        : 1;
  const record: BrowserRunRecord = {
    schemaVersion: BROWSER_RUN_SCHEMA_VERSION,
    runId,
    adapter: BROWSER_ADAPTER,
    target: input.target,
    scenario: scenario.name,
    locale: scenario.locale,
    corpus: { version: corpus.version, sha256: corpus.fingerprint },
    scenarioFingerprint: scenario.fingerprint,
    codeFingerprint,
    certifiable: true,
    startedAt,
    endedAt: new Date().toISOString(),
    status: runStatus,
    call: callRecord,
    certification: certificate === null ? "withheld" : "issued",
    certificationReason,
    certificate:
      certificate === null || certificateFile === null
        ? null
        : {
            file: certificateFile,
            verdict: certificate.verdict,
            pass: certificate.pass,
          },
    verdict: {
      verdict: verdict.verdict,
      failedPropertyIds: verdict.failedPropertyIds,
      unknownPropertyIds: verdict.unknownPropertyIds,
      failures: verdict.failures,
      detail: verdict.detail,
      file: verdictFile,
    },
    cards: { file: cardsFile, count: cards.length, gaps: allCardGaps },
    browserBudget,
    unrun,
    parity,
    refusal: null,
  };
  await writeJson(join(runDir, "run.json"), record);

  return {
    runId,
    runDir,
    status: runStatus,
    attempt,
    eligibility: assembled.eligibility,
    pipelineImage: preflightAnswer.pipelineBuild,
    cost: (assembled.bundle.cost as Record<string, unknown> | undefined) ?? null,
    exitCode,
    verdict,
    certificateFile,
    cards,
    cardGaps: allCardGaps,
    call: callRecord,
    unrun,
    corpus: { version: corpus.version, sha256: corpus.fingerprint },
    scenario,
    target: input.target as CardTarget,
    locale: scenario.locale,
    parity,
    refusal: null,
  };
}

/** Run the exact replay command a defect card carries, unchanged. */
export async function runReplayCommand(
  command: string,
  input: Omit<BrowserRunInput, "scenarioName" | "target" | "locale">,
): Promise<BrowserRunResult> {
  const replay = parseReplayCommand(command);
  return runBrowserCertification({
    ...input,
    scenarioName: replay.scenario,
    target: replay.target,
    locale: replay.locale,
  });
}

export type { LoadedScenario };
