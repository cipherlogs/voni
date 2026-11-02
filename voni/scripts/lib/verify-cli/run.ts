/**
 * `demo:verify`: one command answers "is the demo ready" for a named target,
 * plan and Locale, and its exit code is the contract.
 *
 * The dispatch is deliberately thin. Parsing decides what was asked; planning
 * decides the shape the spec defines and names every corpus gap; this module
 * preflights the facts a run cannot start without, takes the timing lock,
 * drives the injected adapter, judges the calls with the real verdict core and
 * issues at most one certificate.
 *
 * Rules this module owns:
 * - a diagnose run never writes a certificate and the protocol adapter never
 *   returns 0 (a clean diagnosis is exit 1, not a pass);
 * - a fast or nightly report is never a certificate, so it exits 1 even when
 *   scoped-clean;
 * - only a full run builds a certificate, bound to its own target and code
 *   fingerprint; a green never inherits;
 * - a missing key, corpus, vendor build or the held timing lock is exit 2 with
 *   the item named, never a wait and never a skip.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Commands and exit codes" and
 * "Targets, runs and cadence"; ADR 0013.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CodeFingerprint } from "@/lib/demo/scoreboard";
import {
  CertificateError,
  OPEN_RESIDUAL_RISK_IDS,
  REQUIRED_VENDOR_LEGS,
  buildCertificate,
  certificateExitCode,
  certificateFile,
  validateCertificate,
  type Certificate,
  type CertificateExpectation,
  type CertificateResume,
  type CertificationAttempt,
  type PanelSignature,
  type VendorBuild,
} from "@/lib/demo/verification/certificate";
import type { Contract } from "@/lib/demo/verification/contract";
import {
  RunCeilingError,
  preflightRunCeiling,
  readPricedRow,
  scopeRunToCeiling,
  type RunCostRow,
} from "@/lib/demo/verification/economics";
import {
  applyPanelVerdict,
  judgePanel,
  type PanelJudgementInput,
} from "@/lib/demo/verification/panel";
import {
  DEFAULT_CORPUS_DIR,
  ScenarioError,
  judgeFastRun,
  type Corpus,
  type Locale,
} from "@/lib/demo/verification/scenarios";
import {
  evaluateScenarios,
  judgeRun,
  type CallEligibilityFact,
  type PropertyEvaluator,
  type RunVerdict,
  type ScenarioAttempt,
} from "@/lib/demo/verification/verdict";
import { TimingLockHeldError, type TimingLock } from "@/lib/demo/timing-lock";

import {
  PROTOCOL_REQUIRED_KEYS,
  defaultVendorBuildsPath,
} from "../protocol-adapter/refusals";
import type { VendorBuildRecord } from "../protocol-adapter/types";
import type { VerifyRequest } from "./args";
import { VerifyCliError, refuse } from "./errors";
import {
  JOURNAL_SCHEMA_VERSION,
  acquireJournalLock,
  assertEvidencePresent,
  assertResumable,
  callKey,
  journalPath,
  openJournal,
  readJournal,
  truncateTornTail,
  writeJournal,
  type JournalCallRecord,
  type JournalHeader,
  type JournalLock,
  type JournalRetryRecord,
  type JournalWriter,
  type LoadedJournal,
} from "./journal";
import { planVerify, runKindOf, type VerifyPlan } from "./plan";

/**
 * The minimum interval between two calls' starts. The TTS vendor allows five
 * synthesis sessions per minute per account and a call opens at least one; 30 s
 * keeps the contract's own call rate under that allowance with room for a
 * session that reopens. A run may set `DEMO_VERIFY_CALL_INTERVAL_MS`; zero is
 * accepted only to make the pacing explicit in a test.
 */
export const DEFAULT_CALL_INTERVAL_MS = 30_000;

export function callIntervalMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.DEMO_VERIFY_CALL_INTERVAL_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_CALL_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CALL_INTERVAL_MS;
}

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const DEFAULT_RUN_ID = (): string =>
  `verify-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;

/** What the protocol adapter reports back; it never certifies. */
export type DiagnoseInput = {
  readonly request: VerifyRequest;
};

export type DiagnoseOutcome = {
  readonly status: string;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly runId: string;
  readonly runDir: string;
  readonly refusal: { readonly code: string; readonly message: string } | null;
};

/** One call the plan asked the browser adapter to make. */
export type ScenarioCallInput = {
  readonly request: VerifyRequest;
  readonly scenario: string;
  readonly locale: Locale;
  readonly target: VerifyRequest["target"];
  readonly repetition: number;
};

/**
 * One call's evidence. `attempt` is what the verdict core judges; it is null
 * only when the adapter refused, and a refusal names itself.
 */
export type ScenarioCallOutcome = {
  readonly refusal: { readonly code: string; readonly message: string } | null;
  readonly attempt: ScenarioAttempt | null;
  readonly eligibility: CallEligibilityFact | null;
  /** The pipeline build the call served; a certificate records it. */
  readonly pipelineImage: string | null;
  /**
   * The artifacts that support this call, by path. The journal records them so
   * a resume can prove the evidence on disk still backs the call; an empty
   * list means the attempt carries its evidence inline.
   */
  readonly evidenceRefs?: readonly string[];
  /**
   * The call's own priced row, even when the call failed after serving. A
   * failure that priced nothing is recorded as null and refuses the total,
   * never silently dropped from spend.
   */
  readonly cost?: unknown;
};

/**
 * Everything the command reads. Tests inject the adapters, the corpus and the
 * clock; the entry point wires the real browser and protocol adapters.
 *
 * `signature` is the owner's panel signature, when `demo:certificate` has
 * already signed this run. A run never invents one; it is injectable so the
 * exit contract (3 while pending, 0 when signed) is testable.
 *
 * `panel` is the panel's gold-label set plus its signature, when the panel has
 * run. It is merged into H1-H5/H7 before the certificate is built, so a signed
 * full run can reach `certified`; without it those properties stay
 * pending-human and the run exits 3, never 0.
 */
export type VerifyDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  /** A monotonic millisecond clock for call pacing; tests inject it. */
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly loadContract: () => Promise<Contract>;
  readonly loadCorpus: (options: {
    readonly knownProperties: ReadonlySet<string>;
    readonly dir: string | URL;
  }) => Promise<Corpus>;
  readonly loadEvaluators: (contract: Contract) => Promise<readonly PropertyEvaluator[]>;
  readonly readVendorBuilds: (path: string) => Promise<VendorBuildRecord | null>;
  readonly acquireLock: (options: {
    readonly path?: string;
    readonly scenario?: string;
  }) => TimingLock;
  readonly readCodeFingerprint: () => CodeFingerprint | null;
  readonly newRunId?: () => string;
  readonly diagnose: (input: DiagnoseInput) => Promise<DiagnoseOutcome>;
  readonly runScenario: (input: ScenarioCallInput) => Promise<ScenarioCallOutcome>;
  readonly plan?: (input: {
    readonly request: VerifyRequest;
    readonly corpus: Corpus;
  }) => VerifyPlan;
  readonly signature?: PanelSignature | null;
  /** The panel's gold labels and signature, when the panel has run. */
  readonly panel?: PanelJudgementInput | null;
  /**
   * Where certification journals live. Absent uses `--run-root` (then
   * `.demo-runs`); tests inject a temporary root so a suite never writes beside
   * a live run; `null` disables journaling.
   */
  readonly journalRoot?: string | null;
};

/**
 * How a certificate was assembled across an interruption. The owner must be
 * able to see that the run stopped and continued, and which calls each half
 * contributed; a reused call is never presented as freshly measured.
 */
export type ResumeRecord = {
  /** The original run id; a certificate keeps it. */
  readonly runId: string;
  readonly journalPath: string;
  readonly originalStartedAt: string;
  readonly resumedAt: string;
  /** Call ids reused from the journal's completed half. */
  readonly reusedCalls: readonly string[];
  /** Call ids this half made. */
  readonly madeCalls: readonly string[];
};

export type VerifyStatus =
  | "certified"
  | "pending-human"
  | "not-demo-ready"
  | "ineligible"
  | "scoped-pass"
  | "health-clean"
  | "diagnosed"
  | "refused";

export type VerifyResult = {
  readonly mode: VerifyRequest["mode"];
  readonly target: VerifyRequest["target"];
  readonly locale: Locale | null;
  readonly scenario: string | null;
  readonly status: VerifyStatus;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly runId: string | null;
  readonly calls: number;
  readonly certificate: Certificate | null;
  readonly certificatePath: string | null;
  readonly certificateVerdict: Certificate["verdict"] | null;
  readonly refusals: readonly string[];
  readonly unrun: readonly string[];
  readonly detail: string;
  /**
   * The property ids the run measured as failures, from the verdict itself.
   * A CI gate reads this, never prose: zero ids is the evidence a property
   * gate needs, and one id reds the run whatever the exit code says.
   */
  readonly failedPropertyIds: readonly string[];
  /** A fallback-contaminated or otherwise ineligible run can never green. */
  readonly ineligible: boolean;
  /**
   * Calls re-made because they produced no evidence at all. The first attempt
   * is kept beside the run; a retry is never a substitute for a measured
   * result and never turns a failure green.
   */
  readonly retries: readonly EvidenceRetry[];
  /**
   * Non-null only when `--resume` continued an interrupted run. A fresh run is
   * never labelled resumed, even though it journals as it goes.
   */
  readonly resumed: ResumeRecord | null;
};

function emptyResult(
  request: VerifyRequest,
  status: VerifyStatus,
  exitCode: VerifyResult["exitCode"],
): VerifyResult {
  return {
    mode: request.mode,
    target: request.target,
    locale: request.locale ?? null,
    scenario: request.scenario ?? null,
    status,
    exitCode,
    runId: null,
    calls: 0,
    certificate: null,
    certificatePath: null,
    certificateVerdict: null,
    refusals: [],
    unrun: [],
    detail: "",
    failedPropertyIds: [],
    ineligible: false,
    retries: [],
    resumed: null,
  };
}

function refused(request: VerifyRequest, error: VerifyCliError): VerifyResult {
  return {
    ...emptyResult(request, "refused", 2),
    refusals: [error.message, ...error.missing.filter((item) => !error.message.includes(item))],
    detail: `${error.code}: ${error.message}`,
  };
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** The startup facts that are missing, all named at once. */
async function startupGaps(
  request: VerifyRequest,
  plan: VerifyPlan,
  deps: VerifyDeps,
): Promise<{ readonly items: string[]; readonly code: VerifyCliError["code"] | null; readonly builds: VendorBuild[] }> {
  const items: string[] = [];

  for (const key of PROTOCOL_REQUIRED_KEYS) {
    const value = deps.env[key];
    if (typeof value !== "string" || value.trim() === "") {
      items.push(`key ${key} is not set; the real call path cannot open a vendor without it`);
    }
  }

  const path = request.vendorBuildsPath ?? defaultVendorBuildsPath();
  const record = await deps.readVendorBuilds(path);
  if (record === null) {
    items.push(
      `vendor-builds ${path} is missing; an unrecorded build refuses the run (RR-03)`,
    );
  } else {
    for (const leg of REQUIRED_VENDOR_LEGS) {
      if (!record.builds.some((build) => build.leg === leg)) {
        items.push(
          `vendor-build leg "${leg}" has no recorded build in ${path}; RR-03 refuses the run`,
        );
      }
    }
  }

  for (const gap of plan.gaps) items.push(`corpus ${gap}`);

  const code =
    items.length === 0
      ? null
      : items.some((item) => item.startsWith("key "))
        ? "missing-key"
        : items.some((item) => item.startsWith("vendor-builds") || item.startsWith("vendor-build leg"))
          ? "missing-vendor-build"
          : "missing-corpus";

  return {
    items,
    code,
    builds:
      record === null
        ? []
        : record.builds.map((build) => ({
            leg: build.leg,
            vendor: build.vendor,
            model: build.model,
            buildId: build.buildId,
          })),
  };
}

/** One call that was re-made because it produced no evidence at all. */
export type EvidenceRetry = {
  readonly scenario: string;
  readonly repetition: number;
  /** The refusal the first attempt ended with. */
  readonly code: string;
  readonly message: string;
  readonly at: string;
};

/**
 * The refusal codes that mean "this call produced no evidence at all": the app
 * never posted the marks that bind the call, or the harness could not open the
 * call. Nothing was measured, so a second attempt cannot turn a result green.
 *
 * A call that ran and failed (a trigger that never resolved, a property below
 * bar, a dropped socket after turns) is NOT here: its evidence is judged, and
 * retrying it would be the retry-to-green the spec forbids.
 */
export const RETRYABLE_NO_EVIDENCE: ReadonlySet<string> = new Set([
  "marks-missing",
  "capture-missing",
  "call-refused",
  // The stack was unreachable before the call: nothing was measured either.
  "pipeline-unreachable",
  "app-unreachable",
]);

/** The open journal one certification run reads and extends. */
type JournalSession = {
  readonly path: string;
  readonly header: JournalHeader;
  readonly resume: boolean;
  readonly calls: ReadonlyMap<string, JournalCallRecord>;
  readonly retries: ReadonlyMap<string, JournalRetryRecord>;
  readonly interrupted: ReadonlySet<string>;
  readonly writer: JournalWriter;
  readonly resumedAt: string;
  readonly lock: JournalLock;
};

/** A journaled failure carried forward: it stays failed and is not re-made. */
type ReusedFailure = {
  readonly scenario: string;
  readonly repetition: number;
  readonly code: string;
  readonly message: string;
};

type Collected = {
  readonly attempts: readonly ScenarioAttempt[];
  readonly callAttempts: readonly CertificationAttempt[];
  readonly eligibility: readonly CallEligibilityFact[];
  readonly costs: readonly RunCostRow[];
  readonly pipelineImage: string | null;
  readonly retries: readonly EvidenceRetry[];
  /** Failed calls the journal carried; they are not in `attempts`. */
  readonly failures: readonly ReusedFailure[];
  readonly resumed: ResumeRecord | null;
};

function nowIso(deps: VerifyDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

async function collectCalls(
  request: VerifyRequest,
  plan: VerifyPlan,
  deps: VerifyDeps,
  journal: JournalSession | null,
): Promise<Collected> {
  const attempts: ScenarioAttempt[] = [];
  const callAttempts: CertificationAttempt[] = [];
  const eligibility: CallEligibilityFact[] = [];
  const costs: RunCostRow[] = [];
  let pipelineImage: string | null = null;
  // A resume starts a new pacing window: the old run's last start is not this
  // half's, and the TTS allowance must be re-proved after the gap. The first
  // made call therefore waits the full interval even when the journal stopped
  // one call ago. A fresh run has no previous start.
  let lastStart: number | null = journal?.resume === true ? (deps.clock?.() ?? Date.now()) : null;
  const retries: EvidenceRetry[] = [];
  const failures: ReusedFailure[] = [];
  const reusedIds: string[] = [];
  const madeIds: string[] = [];

  // A re-made call's record belongs to the whole run, not to one half. Carry
  // every journaled retry verbatim so the resumed result names it once.
  for (const retry of journal?.retries.values() ?? []) {
    retries.push({
      scenario: retry.scenario,
      repetition: retry.repetition,
      code: retry.code,
      message: retry.message,
      at: retry.at,
    });
  }

  for (const scenario of plan.scenarios) {
    for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
      const key = callKey(scenario.name, repetition);
      const recorded = journal?.calls.get(key);
      // A completed call is reused as-is: its attempt, eligibility and cost
      // row are the journal's own, never re-derived from a vendor.
      if (recorded?.outcome === "completed") {
        const attempt: ScenarioAttempt = {
          ...(recorded.attempt as ScenarioAttempt),
          scenario: scenario.name,
          repetition,
          locale: scenario.locale,
          target: plan.target,
        };
        const callId = recorded.callId;
        attempts.push(attempt);
        callAttempts.push({
          scenario: scenario.name,
          locale: scenario.locale,
          repetition,
          callId,
        });
        eligibility.push({
          ...(recorded.eligibility as CallEligibilityFact),
          callId,
          scenario: scenario.name,
        });
        costs.push({ callId, scenario: scenario.name, cost: recorded.cost });
        if (pipelineImage === null) pipelineImage = recorded.pipelineImage;
        reusedIds.push(callId);
        continue;
      }
      // A failed call stays failed. It is not re-made: no evidence can turn a
      // measured failure green, and re-running it would be exactly that.
      if (recorded?.outcome === "failed") {
        failures.push({
          scenario: scenario.name,
          repetition,
          code: recorded.refusal?.code ?? "adapter-refused",
          message: recorded.refusal?.message ?? "the journal records a failed call",
        });
        // The failed call still spent. Its own row is carried so the total is
        // the whole run's spend; a null row fails the total closed and names
        // the call rather than dropping it.
        costs.push({ callId: recorded.callId, scenario: scenario.name, cost: recorded.cost });
        if (pipelineImage === null) pipelineImage = recorded.pipelineImage;
        reusedIds.push(recorded.callId);
        continue;
      }
      // A call that was already re-made once but whose result never landed has
      // spent its one retry. It stays a failure rather than being tried again.
      if (journal?.interrupted.has(key) === true) {
        failures.push({
          scenario: scenario.name,
          repetition,
          code: "journal-interrupted",
          message:
            "the journal records the one allowed re-make of this call with no result; the " +
            "interruption stays a failure and the call is not made again",
        });
        continue;
      }

      // TTS sessions are vendor-limited (five a minute per account), and a call
      // opens at least one. Pacing the starts keeps a run inside that allowance
      // instead of retrying a call that never had a chance to exist; a retry
      // would have to stand as a failure under the no-retry-to-green rule.
      if (lastStart !== null) {
        const interval = callIntervalMs(deps.env);
        const waited = (deps.clock?.() ?? Date.now()) - lastStart;
        if (waited < interval) await (deps.sleep?.((interval - waited) | 0) ?? sleepMs(interval - waited));
      }
      lastStart = deps.clock?.() ?? Date.now();
      // The start sentinel is durable before the call opens. A process death
      // after it leaves a started call with no completion record, which a
      // resume classifies interrupted and never re-makes.
      journal?.writer.append({
        type: "start",
        scenario: scenario.name,
        repetition,
        at: nowIso(deps),
      });
      let outcome = await deps.runScenario({
        request,
        scenario: scenario.name,
        locale: scenario.locale,
        target: plan.target,
        repetition,
      });
      // A call with no evidence is re-made once, and both attempts are kept in
      // the run. Nothing was measured, so this cannot make a failure green; it
      // only stops an infrastructure hiccup from costing the whole run. The
      // second attempt's refusal stands, unretried.
      if (outcome.refusal !== null && RETRYABLE_NO_EVIDENCE.has(outcome.refusal.code)) {
        const first = outcome.refusal;
        const retry = {
          scenario: scenario.name,
          repetition,
          code: first.code,
          message: first.message,
          at: nowIso(deps),
        };
        retries.push(retry);
        // Write the re-make before it happens: a process death during the retry
        // must not let a later resume make the call a second time.
        journal?.writer.append({ type: "retry", ...retry });
        const interval = callIntervalMs(deps.env);
        await (deps.sleep?.(interval) ?? sleepMs(interval));
        lastStart = deps.clock?.() ?? Date.now();
        outcome = await deps.runScenario({
          request,
          scenario: scenario.name,
          locale: scenario.locale,
          target: plan.target,
          repetition,
        });
      }
      if (outcome.refusal !== null) {
        const remade =
          retries.length === 0
            ? ""
            : `; this run re-made ${retries.length} call(s) that produced no evidence ` +
              `(${retries.map((retry) => `${retry.scenario}#${retry.repetition} ${retry.code}`).join(", ")})`;
        // The failure is durable before the refusal is thrown, so `--resume`
        // carries it instead of paying for the call again.
        journal?.writer.append({
          type: "call",
          scenario: scenario.name,
          repetition,
          locale: scenario.locale,
          callId: outcome.eligibility?.callId ?? key,
          outcome: "failed",
          attempt: null,
          eligibility: null,
          cost: outcome.cost ?? null,
          pipelineImage: outcome.pipelineImage,
          evidenceRefs: [],
          refusal: outcome.refusal,
          at: nowIso(deps),
        });
        refuse(
          "adapter-refused",
          `${scenario.name} repetition ${repetition} refused (${outcome.refusal.code}): ` +
            outcome.refusal.message +
            remade,
          [outcome.refusal.code],
        );
      }
      if (outcome.attempt === null) {
        refuse(
          "adapter-refused",
          `${scenario.name} repetition ${repetition} produced no attempt evidence; a call ` +
            "without evidence is a refusal, never a skipped scenario",
        );
      }
      const callId = outcome.eligibility?.callId ?? key;
      const attempt: ScenarioAttempt = {
        ...outcome.attempt,
        scenario: scenario.name,
        repetition,
        locale: scenario.locale,
        target: plan.target,
      };
      const eligibilityFact: CallEligibilityFact = {
        ...(outcome.eligibility ?? { callId, scenario: scenario.name }),
        callId,
        scenario: scenario.name,
      };
      const evidenceRefs = (outcome.evidenceRefs ?? []).map((ref) =>
        isAbsolute(ref) ? ref : resolve(ref),
      );
      if (journal !== null && evidenceRefs.length === 0) {
        refuse(
          "journal-provenance-missing",
          `${scenario.name} repetition ${repetition} produced an attempt but named no evidence ` +
            "path; a journal cannot claim a call it cannot point to",
        );
      }
      // A missing cost row is recorded as null, an unmeasured leg that fails
      // the total closed; it is never omitted from a completed call.
      const costRow = attempt.evidence.cost ?? outcome.cost ?? null;
      journal?.writer.append({
        type: "call",
        scenario: scenario.name,
        repetition,
        locale: scenario.locale,
        callId,
        outcome: "completed",
        attempt,
        eligibility: eligibilityFact,
        cost: costRow,
        pipelineImage: outcome.pipelineImage,
        evidenceRefs,
        refusal: null,
        at: nowIso(deps),
      });
      attempts.push(attempt);
      callAttempts.push({
        scenario: scenario.name,
        locale: scenario.locale,
        repetition,
        callId,
      });
      eligibility.push(eligibilityFact);
      costs.push({ callId, scenario: scenario.name, cost: costRow });
      if (pipelineImage === null) pipelineImage = outcome.pipelineImage;
      madeIds.push(callId);
    }
  }

  const resumed: ResumeRecord | null =
    journal !== null && journal.resume
      ? {
          runId: journal.header.runId,
          journalPath: journal.path,
          originalStartedAt: journal.header.startedAt,
          resumedAt: journal.resumedAt,
          reusedCalls: [...reusedIds],
          madeCalls: [...madeIds],
        }
      : null;

  return {
    attempts,
    callAttempts,
    eligibility,
    costs,
    pipelineImage,
    retries,
    failures,
    resumed,
  };
}

function measuredCost(costs: readonly RunCostRow[]): number {
  const unmeasured: string[] = [];
  let total = 0;
  for (const call of costs) {
    try {
      const priced = readPricedRow(call.cost);
      if (!priced.measured || priced.totalUsd === null) {
        unmeasured.push(`${call.callId} (${priced.unmeasuredReason ?? "unmeasured"})`);
        continue;
      }
      total += priced.totalUsd;
    } catch (error) {
      unmeasured.push(`${call.callId} (${(error as Error).message})`);
    }
  }
  if (unmeasured.length > 0) {
    refuse(
      "certificate-refused",
      `the run has no cost total: ${unmeasured.join(", ")}. A certificate carries the calls' ` +
        "own priced rows and never a partial sum",
    );
  }
  return Math.round(total * 1_000_000) / 1_000_000;
}

function certificateFor(input: {
  readonly contract: Contract;
  readonly run: RunVerdict;
  readonly plan: VerifyPlan;
  readonly corpus: Corpus;
  readonly builds: readonly VendorBuild[];
  readonly collected: Collected;
  readonly fingerprint: CodeFingerprint;
  readonly panel: PanelSignature | null;
  readonly resume: CertificateResume | null;
}): Certificate {
  if (input.collected.pipelineImage === null) {
    refuse(
      "certificate-refused",
      "no call recorded the pipeline build it served; a certificate must name the image it ran",
    );
  }
  if (input.builds.length === 0) {
    refuse("certificate-refused", "no vendor build was recorded for this run (RR-03)");
  }
  const usd = measuredCost(input.collected.costs);
  // One certificate only ever claims the target, code and corpus it ran; the
  // reader refuses a different one by name.
  return buildCertificate({
    contract: input.contract,
    run: input.run,
    target: input.plan.target,
    plan: { mode: input.plan.mode === "full" ? "full" : "nightly", repetitions: input.plan.repetitions },
    corpus: {
      version: input.corpus.version,
      fingerprint: input.corpus.fingerprint,
      scenarios: input.plan.scenarios.map((scenario) => ({
        name: scenario.name,
        locale: scenario.locale,
        heldOut: scenario.heldOut,
      })),
    },
    attempts: [...input.collected.callAttempts],
    codeFingerprint: input.fingerprint,
    appBuild: input.fingerprint.head,
    pipelineImage: input.collected.pipelineImage,
    vendorBuilds: [...input.builds],
    cost: { usd, callCount: input.collected.costs.length },
    residualRiskIds: [...OPEN_RESIDUAL_RISK_IDS],
    panel: input.panel,
    resume: input.resume,
  });
}

/** The certificate shape the call-accounting check reads. */
export type CallAccountingCertificate = {
  readonly cost: { readonly callCount: number };
  readonly coverage: {
    readonly rows: readonly { readonly calls: readonly string[] }[];
  };
};

/**
 * The certificate's call count, coverage and resume halves must agree. A
 * failed reused call spends and is counted in cost, but it is a coverage gap,
 * not a measured call; every measured attempt must appear once in coverage.
 */
export function assertCallAccounting(
  certificate: CallAccountingCertificate,
  attempts: number,
  resumed: ResumeRecord | null,
): void {
  const uniqueCalls = new Set(certificate.coverage.rows.flatMap((row) => row.calls));
  const coverageCalls = certificate.coverage.rows.reduce(
    (total, row) => total + row.calls.length,
    0,
  );
  if (uniqueCalls.size !== coverageCalls) {
    refuse(
      "journal-attempt-mismatch",
      `accounting mismatch: coverage names ${uniqueCalls.size} unique call id(s) across ${coverageCalls} row ` +
        "entries; one call id cannot measure two attempts",
    );
  }
  if (coverageCalls !== attempts) {
    refuse(
      "journal-attempt-mismatch",
      `accounting mismatch: the run made ${attempts} measured call(s), but coverage names ${coverageCalls}`,
    );
  }
  if (certificate.cost.callCount < coverageCalls) {
    refuse(
      "journal-attempt-mismatch",
      `accounting mismatch: the certificate's cost covers ${certificate.cost.callCount} call(s), fewer than the ` +
        `${coverageCalls} measured call(s) coverage names`,
    );
  }
  if (resumed === null) {
    if (certificate.cost.callCount !== attempts) {
      refuse(
        "journal-attempt-mismatch",
        `accounting mismatch: the certificate's cost covers ${certificate.cost.callCount} call(s), but the run made ` +
          `${attempts}; a fresh run has no other half to explain the difference`,
      );
    }
    return;
  }
  const halves = resumed.reusedCalls.length + resumed.madeCalls.length;
  if (halves !== certificate.cost.callCount) {
    refuse(
      "journal-attempt-mismatch",
      `accounting mismatch: the resume names ${resumed.reusedCalls.length} reused + ${resumed.madeCalls.length} ` +
        `made call(s), but the certificate's cost covers ${certificate.cost.callCount}`,
    );
  }
}

/** The certificate's run record of an interruption, from the resume itself. */
function certificateResume(resumed: ResumeRecord | null): CertificateResume | null {
  return resumed === null
    ? null
    : {
        journalRunId: resumed.runId,
        journalPath: resumed.journalPath,
        originalStartedAt: resumed.originalStartedAt,
        resumedAt: resumed.resumedAt,
        reusedCalls: [...resumed.reusedCalls],
        madeCalls: [...resumed.madeCalls],
      };
}

/**
 * The run's exit. A certificate is re-read against the target and run it is
 * supposed to certify before its verdict is trusted, so a green cannot be
 * borrowed from another target or another code fingerprint.
 */
export function exitForCertificate(
  certificate: Certificate,
  expectation: CertificateExpectation,
): 0 | 1 | 2 | 3 {
  try {
    const checked = validateCertificate(certificate, expectation);
    return certificateExitCode(checked.verdict);
  } catch (error) {
    if (error instanceof CertificateError) {
      refuse("certificate-refused", `${error.code}: ${error.message}`);
    }
    throw error;
  }
}

async function diagnoseRun(
  request: VerifyRequest,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const result = await deps.diagnose({ request });
  if (result.refusal !== null) {
    return refused(
      request,
      new VerifyCliError(
        "adapter-refused",
        `${result.runId}: ${result.refusal.message}`,
        [result.refusal.code],
      ),
    );
  }
  if (result.exitCode === 0) {
    refuse(
      "adapter-refused",
      `${result.runId}: the protocol adapter reported exit 0; a diagnosis never certifies and ` +
        "never returns 0",
    );
  }
  const summarized: VerifyResult = {
    ...emptyResult(request, "diagnosed", 1),
    runId: result.runId,
    calls: 1,
    detail:
      `${result.status}: the diagnosis judged one scenario and withheld certification ` +
      `(${result.runDir}); a certificate comes only from a full run`,
  };
  return summarized;
}

async function fastRun(
  request: VerifyRequest,
  plan: VerifyPlan,
  corpus: Corpus,
  contract: Contract,
  evaluators: readonly PropertyEvaluator[],
  deps: VerifyDeps,
  startedAt: string,
): Promise<VerifyResult> {
  const collected = await collectCalls(request, plan, deps, null);
  const endedAt = (deps.now ?? (() => new Date()))().toISOString();
  // E3 is run-scoped and has one owner: the economics run gate. The fast
  // module presents that owner's total and boolean verbatim and narrows the
  // scoped verdict with them; it never re-sums cost or re-resolves the ceiling.
  const scoped = scopeRunToCeiling({
    contract,
    evidence: await evaluateScenarios({
      contract,
      evaluators,
      attempts: [...collected.attempts],
    }),
    kind: "fast",
    calls: [...collected.costs],
  });
  const verdict = judgeRun({
    runId: (deps.newRunId ?? defaultRunId)(),
    contract: scoped.contract,
    evidence: scoped.evidence,
    calls: [...collected.eligibility],
  });
  const report = judgeFastRun({
    contract: scoped.contract,
    corpus,
    verdict,
    calls: collected.attempts.map((attempt) => ({ scenario: attempt.scenario })),
    ceiling: scoped.check,
    startedAt,
    endedAt,
  });

  const status: VerifyStatus =
    report.verdict === "scoped-pass"
      ? "scoped-pass"
      : report.verdict === "ineligible"
        ? "ineligible"
        : "not-demo-ready";
  return {
    ...emptyResult(request, status, 1),
    calls: collected.attempts.length,
    failedPropertyIds: report.failedPropertyIds,
    ineligible: report.verdict === "ineligible",
    retries: collected.retries,
    detail:
      `${report.scopeNote} ${report.economy.detail}` +
      (report.failedPropertyIds.length === 0
        ? ""
        : ` Failed in scope: ${report.failedPropertyIds.join(", ")}.`) +
      " A scoped-pass is not a certificate; exit 0 is reserved for a signed full certification",
    unrun: unique([
      ...report.gaps,
      ...collected.retries.map(
        (retry) =>
          `${retry.scenario} repetition ${retry.repetition} produced no evidence and was re-made ` +
          `(${retry.code}: ${retry.message.slice(0, 120)}); a retry never turns a result green`,
      ),
      ...report.outOfScopeFamilies.map((family) => family.reason),
      // Only the in-scope failures belong here. The run verdict fails every
      // property no attempt cites closed; those are the scope's out-of-scope
      // families, already reported as families above, never as failures.
      ...report.failedPropertyIds.map((id) => `${id} failed in the fast scope`),
      ...verdict.failures,
    ]),
  };
}

/**
 * Open the run's journal: a fresh file with its header, or the interrupted
 * run's journal after every proof a resume needs. The run id and the code
 * fingerprint the certificate keeps are the journal's, never a fresh guess.
 */
function certificationJournal(input: {
  readonly request: VerifyRequest;
  readonly plan: VerifyPlan;
  readonly corpus: Corpus;
  readonly builds: readonly VendorBuild[];
  readonly fingerprint: CodeFingerprint;
  readonly runId: string;
  readonly resumedAt: string;
  readonly deps: VerifyDeps;
}): JournalSession | null {
  const configured = input.deps.journalRoot;
  if (configured === null) return null;
  if (input.plan.mode !== "full" && input.plan.mode !== "nightly") {
    refuse(
      "resume-mode-unsupported",
      `the ${input.plan.mode} run has no certification journal; only --full and --nightly ` +
        "runs journal their calls",
    );
  }
  const mode: "full" | "nightly" = input.plan.mode;
  const path = journalPath(configured ?? input.request.runRoot, input.runId);
  const header: JournalHeader = {
    type: "header",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId: input.runId,
    startedAt: input.resumedAt,
    target: input.plan.target,
    mode,
    codeFingerprint: input.fingerprint,
    corpus: { version: input.corpus.version, sha256: input.corpus.fingerprint },
    vendorBuilds: [...input.builds],
    plan: {
      mode,
      repetitions: input.plan.repetitions,
      calls: input.plan.calls,
      scenarios: input.plan.scenarios.map((scenario) => ({
        name: scenario.name,
        locale: scenario.locale,
        heldOut: scenario.heldOut,
      })),
    },
  };

  // One writer per run id. A refusal below releases the lock before it throws.
  const lock = acquireJournalLock(path);
  try {
    if (input.request.resume === undefined) {
      writeJournal(path, header);
      return {
        path,
        header,
        resume: false,
        calls: new Map(),
        retries: new Map(),
        interrupted: new Set(),
        writer: openJournal(path),
        resumedAt: input.resumedAt,
        lock,
      };
    }

    // Read and prove before writing anything: a refused resume must leave the
    // journal exactly as it found it, including a torn tail.
    const loaded: LoadedJournal = readJournal(path);
    assertResumable(loaded, {
      runId: input.runId,
      target: input.plan.target,
      codeFingerprint: input.fingerprint,
      corpus: { version: input.corpus.version, sha256: input.corpus.fingerprint },
      vendorBuilds: input.builds,
      plan: input.plan,
    });
    assertEvidencePresent(loaded);
    truncateTornTail(loaded);
    return {
      ...loaded,
      resume: true,
      writer: openJournal(path),
      resumedAt: input.resumedAt,
      lock,
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function certificationRun(
  request: VerifyRequest,
  plan: VerifyPlan,
  corpus: Corpus,
  contract: Contract,
  evaluators: readonly PropertyEvaluator[],
  builds: readonly VendorBuild[],
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const fingerprint = deps.readCodeFingerprint();
  if (fingerprint === null) {
    refuse(
      "certificate-refused",
      "the repository has no readable HEAD; a run that journals and certifies must bind to " +
        "the code it ran",
    );
  }
  // A resume keeps the original run id and fingerprint; a fresh run claims a
  // new one before its first call, so the journal's header can prove it.
  const runId = request.resume ?? (deps.newRunId ?? defaultRunId)();
  const resumedAt = nowIso(deps);
  const journal = certificationJournal({
    request,
    plan,
    corpus,
    builds,
    fingerprint,
    runId,
    resumedAt,
    deps,
  });

  let collected: Collected;
  try {
    collected = await collectCalls(request, plan, deps, journal);
  } finally {
    try {
      journal?.writer.close();
    } finally {
      journal?.lock.release();
    }
  }

  // The header is the code the run started with. The tree may not move while
  // the calls run: a fresh run and a resumed half both prove the end reading
  // still matches, and nightly health is bound by the same rule.
  const endFingerprint = deps.readCodeFingerprint();
  if (endFingerprint === null) {
    refuse(
      "certificate-refused",
      "the repository has no readable HEAD at the end of the run; a certificate must bind " +
        "to the code it ran",
    );
  }
  const journalFingerprint = journal?.header.codeFingerprint ?? null;
  if (
    journalFingerprint !== null &&
    (journalFingerprint.head !== endFingerprint.head ||
      journalFingerprint.dirty !== endFingerprint.dirty ||
      journalFingerprint.dirtyHash !== endFingerprint.dirtyHash)
  ) {
    refuse(
      "journal-code-mismatch",
      `journal ${journal?.path ?? ""} started on code fingerprint ` +
        `${journalFingerprint.head}${journalFingerprint.dirty ? "+dirty" : ""}, but the ` +
        `repository is now ${endFingerprint.head}${endFingerprint.dirty ? "+dirty" : ""}; ` +
        "a certificate may not claim code it did not measure",
    );
  }

  const kind = request.mode === "full" ? "full" : "nightly";
  const scoped = scopeRunToCeiling({
    contract,
    evidence: await evaluateScenarios({
      contract,
      evaluators,
      attempts: [...collected.attempts],
    }),
    kind,
    calls: [...collected.costs],
  });
  const verdict = judgeRun({
    runId,
    contract: scoped.contract,
    evidence: scoped.evidence,
    calls: [...collected.eligibility],
  });
  // The panel owns H1-H5/H7. Merge its gold-label verdicts before the
  // certificate is built, so the signed run can be certified; without a panel
  // those properties stay pending-human and the exit is 3, never 0.
  const panelInput = deps.panel ?? null;
  const judged =
    panelInput === null
      ? verdict
      : applyPanelVerdict(verdict, judgePanel(contract, panelInput));
  if (request.mode === "nightly") {
    const status: VerifyStatus =
      verdict.verdict === "ineligible"
        ? "ineligible"
        : verdict.verdict === "certified"
          ? "health-clean"
          : "not-demo-ready";
    return {
      ...emptyResult(request, status, 1),
      runId,
      calls: collected.costs.length,
      failedPropertyIds: verdict.failedPropertyIds,
      ineligible: verdict.verdict === "ineligible",
      retries: collected.retries,
      resumed: collected.resumed,
      detail:
        `${verdict.detail}. Nightly health is a report, not a certificate: exit 0 requires a ` +
        "signed full certification",
      unrun: unique([
        ...verdict.failures,
        ...collected.failures.map(
          (failure) =>
            `${failure.scenario} repetition ${failure.repetition} stays failed and was not ` +
            `re-made (${failure.code}: ${failure.message.slice(0, 120)})`,
        ),
        scoped.check.detail,
      ]),
    };
  }

  const certificate = certificateFor({
    contract: scoped.contract,
    run: judged,
    plan,
    corpus,
    builds,
    collected,
    // A journaled certificate names the fingerprint the run started with; the
    // check above proved it still describes the code that finished the run.
    fingerprint: journalFingerprint ?? endFingerprint,
    panel: panelInput?.signature ?? deps.signature ?? null,
    resume: certificateResume(collected.resumed),
  });
  assertCallAccounting(certificate, collected.attempts.length, collected.resumed);
  const exitCode = exitForCertificate(certificate, {
    target: plan.target,
    runId: certificate.runId,
  });

  return {
    ...emptyResult(
      request,
      certificate.verdict as VerifyStatus,
      exitCode,
    ),
    runId: certificate.runId,
    calls: collected.costs.length,
    failedPropertyIds: judged.failedPropertyIds,
    ineligible: judged.verdict === "ineligible",
    retries: collected.retries,
    resumed: collected.resumed,
    certificate,
    certificatePath: fileURLToPath(certificateFile(certificate.runId)),
    certificateVerdict: certificate.verdict,
    detail:
      `${certificate.verdict}: ${verdict.detail}` +
      (certificate.panel === null
        ? "; the certificate is unsigned and pending the owner's panel (exit 3)"
        : `; signed by ${certificate.panel.reviewer} on ${certificate.panel.signedAt}`),
    unrun: unique([
      ...verdict.failures,
      ...collected.failures.map(
        (failure) =>
          `${failure.scenario} repetition ${failure.repetition} stays failed and was not ` +
          `re-made (${failure.code}: ${failure.message.slice(0, 120)})`,
      ),
      ...certificate.properties.filter((property) => property.status === "FAIL").map(
        (property) => `${property.propertyId} failed (${property.reason})`,
      ),
    ]),
  };
}

/**
 * Run one command. A refusal is returned as exit 2 with every missing item
 * named; it is never thrown past this seam, because a refusal is an answer.
 */
export async function runVerify(
  request: VerifyRequest,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  if (request.help) {
    // The entry point prints usage and exits 0; this path exists so a caller
    // that drives `runVerify` directly cannot mistake help for a run.
    return { ...emptyResult(request, "diagnosed", 0), detail: "usage requested" };
  }

  let lock: TimingLock | null = null;
  try {
    // Parsing already refuses this; the dispatch keeps the same rule for a
    // caller that builds a request directly. A scoped report has no journal.
    if (request.resume !== undefined && request.mode !== "full" && request.mode !== "nightly") {
      refuse(
        "resume-mode-unsupported",
        `--resume belongs to a certification run (--full or --nightly); a ${request.mode} run ` +
          "has no journal to continue",
      );
    }
    const contract = await deps.loadContract();
    let corpus: Corpus;
    try {
      corpus = await deps.loadCorpus({
        knownProperties: new Set(contract.properties.map((property) => property.id)),
        dir: request.corpusDir ?? DEFAULT_CORPUS_DIR,
      });
    } catch (error) {
      if (error instanceof ScenarioError) {
        refuse("missing-corpus", error.message, [error.code]);
      }
      throw error;
    }

    const plan = (deps.plan ?? planVerify)({ request, corpus });
    const startup = await startupGaps(request, plan, deps);
    if (startup.items.length > 0) {
      refuse(
        startup.code ?? "missing-corpus",
        `the ${request.mode} run cannot start; missing: ${startup.items.join("; ")}`,
        startup.items,
      );
    }

    const kind = runKindOf(request.mode);
    if (kind !== null) {
      let ceiling;
      try {
        ceiling = preflightRunCeiling({ kind, contract, plannedCalls: plan.calls });
      } catch (error) {
        if (error instanceof RunCeilingError) {
          refuse("run-ceiling", `${error.code}: ${error.message}`);
        }
        throw error;
      }
      if (!ceiling.passed) {
        refuse("run-ceiling", ceiling.detail);
      }
    }

    try {
      lock = deps.acquireLock({
        ...(request.timingLockPath === undefined ? {} : { path: request.timingLockPath }),
        scenario: request.scenario ?? request.mode,
      });
    } catch (error) {
      if (error instanceof TimingLockHeldError) {
        refuse("timing-lock-held", error.message, [error.path]);
      }
      throw error;
    }

    if (request.mode === "diagnose") {
      return await diagnoseRun(request, deps);
    }

    const evaluators = await deps.loadEvaluators(contract);
    const startedAt = (deps.now ?? (() => new Date()))().toISOString();
    if (request.mode === "fast") {
      return await fastRun(request, plan, corpus, contract, evaluators, deps, startedAt);
    }
    return await certificationRun(
      request,
      plan,
      corpus,
      contract,
      evaluators,
      startup.builds,
      deps,
    );
  } catch (error) {
    if (error instanceof VerifyCliError) {
      return refused(request, error);
    }
    if (error instanceof CertificateError) {
      return refused(
        request,
        new VerifyCliError("certificate-refused", `${error.code}: ${error.message}`, [
          error.code,
        ]),
      );
    }
    throw error;
  } finally {
    lock?.release();
  }
}

/** The run id a refusal never needs; the entry's default label. */
export function defaultRunId(): string {
  return DEFAULT_RUN_ID();
}
