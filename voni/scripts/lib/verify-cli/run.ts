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
import { planVerify, runKindOf, type VerifyPlan } from "./plan";

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

type Collected = {
  readonly attempts: readonly ScenarioAttempt[];
  readonly callAttempts: readonly CertificationAttempt[];
  readonly eligibility: readonly CallEligibilityFact[];
  readonly costs: readonly RunCostRow[];
  readonly pipelineImage: string | null;
};

async function collectCalls(
  request: VerifyRequest,
  plan: VerifyPlan,
  deps: VerifyDeps,
): Promise<Collected> {
  const attempts: ScenarioAttempt[] = [];
  const callAttempts: CertificationAttempt[] = [];
  const eligibility: CallEligibilityFact[] = [];
  const costs: RunCostRow[] = [];
  let pipelineImage: string | null = null;

  for (const scenario of plan.scenarios) {
    for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
      const outcome = await deps.runScenario({
        request,
        scenario: scenario.name,
        locale: scenario.locale,
        target: plan.target,
        repetition,
      });
      if (outcome.refusal !== null) {
        refuse(
          "adapter-refused",
          `${scenario.name} repetition ${repetition} refused (${outcome.refusal.code}): ` +
            outcome.refusal.message,
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
      const callId = outcome.eligibility?.callId ?? `${scenario.name}#${repetition}`;
      const attempt: ScenarioAttempt = {
        ...outcome.attempt,
        scenario: scenario.name,
        repetition,
        locale: scenario.locale,
        target: plan.target,
      };
      attempts.push(attempt);
      callAttempts.push({
        scenario: scenario.name,
        locale: scenario.locale,
        repetition,
        callId,
      });
      eligibility.push({
        ...(outcome.eligibility ?? { callId, scenario: scenario.name }),
        callId,
        scenario: scenario.name,
      });
      costs.push({ callId, scenario: scenario.name, cost: attempt.evidence.cost });
      if (pipelineImage === null) pipelineImage = outcome.pipelineImage;
    }
  }

  return { attempts, callAttempts, eligibility, costs, pipelineImage };
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
    cost: { usd, callCount: input.collected.attempts.length },
    residualRiskIds: [...OPEN_RESIDUAL_RISK_IDS],
    panel: input.panel,
  });
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
  const collected = await collectCalls(request, plan, deps);
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
    detail:
      `${report.scopeNote} ${report.economy.detail}. A scoped-pass is not a certificate; ` +
      "exit 0 is reserved for a signed full certification",
    unrun: unique([
      ...report.gaps,
      ...report.outOfScopeFamilies.map((family) => family.reason),
      ...verdict.failedPropertyIds.map((id) => `${id} failed in the fast scope`),
      ...verdict.failures,
    ]),
  };
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
  const collected = await collectCalls(request, plan, deps);
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
    runId: (deps.newRunId ?? defaultRunId)(),
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
      calls: collected.attempts.length,
      failedPropertyIds: verdict.failedPropertyIds,
      ineligible: verdict.verdict === "ineligible",
      detail:
        `${verdict.detail}. Nightly health is a report, not a certificate: exit 0 requires a ` +
        "signed full certification",
      unrun: unique([...verdict.failures, scoped.check.detail]),
    };
  }

  const fingerprint = deps.readCodeFingerprint();
  if (fingerprint === null) {
    refuse(
      "certificate-refused",
      "the repository has no readable HEAD; a certificate must bind to the code it ran",
    );
  }
  const certificate = certificateFor({
    contract: scoped.contract,
    run: judged,
    plan,
    corpus,
    builds,
    collected,
    fingerprint,
    panel: panelInput?.signature ?? deps.signature ?? null,
  });
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
    calls: collected.attempts.length,
    failedPropertyIds: judged.failedPropertyIds,
    ineligible: judged.verdict === "ineligible",
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
