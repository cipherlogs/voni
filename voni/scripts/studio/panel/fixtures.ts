/**
 * Synthetic panel fixtures: a certificate-shaped run, the blind calls, and the
 * signed session. They use the real contract's H1-H7 entries and real bars;
 * only the labels and audio hashes are synthetic.
 */

import { fileRating, type RatingCallInput, type RatingRecord, type RatingSession } from "../rate";
import { buildPanelSession } from "./session";
import { exportGoldLabels } from "./gold-labels";
import { loadContract } from "../../../src/lib/demo/verification/contract";
import { OPEN_RESIDUAL_RISK_IDS } from "../../../src/lib/demo/verification/certificate/risks";
import {
  CERTIFICATE_SCHEMA_VERSION,
  buildCertificate,
  type Certificate,
} from "../../../src/lib/demo/verification/certificate";
import {
  LOCALES,
  type Locale,
  type ScenarioClass,
} from "../../../src/lib/demo/verification/scenarios/types";
import { RATING_AXES } from "../rate";
import { judgeRun, type RunVerdict } from "../../../src/lib/demo/verification/verdict";
import type { PanelGoldLabel, PanelGoldLabelSet } from "../../../src/lib/demo/verification/panel/types";

export const RUN_ID = "run-panel-1";
export const REVIEWER = "owner";
export const SESSION_DATE = "2026-10-31";

export function hash(value: string): string {
  return value
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0).toString(16), "")
    .padEnd(64, "0")
    .slice(0, 64);
}

export function call(
  callId: string,
  scenario: string,
  locale: Locale,
  options: { baseline?: boolean } = {},
): RatingCallInput {
  return {
    callId,
    scenario,
    locale,
    transcript: [
      { speaker: "caller", text: "Hello?", atMs: 0 },
      { speaker: "agent", text: "Hi, how can I help?", atMs: 400 },
    ],
    timeline: [
      { atMs: 0, type: "call-open" },
      { atMs: 400, type: "agent-speech-start" },
      { atMs: 1300, type: "agent-turn-end" },
      { atMs: 3000, type: "call-end" },
    ],
    audio: { path: `calls/${callId}.wav`, sha256: hash(callId) },
    ...(options.baseline === false
      ? {}
      : { baseline: { path: `baseline/${callId}.wav`, sha256: hash(`baseline-${callId}`) } }),
  };
}

/** A simple certificate-shaped record for session-composition tests. */
export function sessionCertificate(options: {
  callsPerLocale?: number;
  failing?: readonly string[];
  /** How many failed property rows each failing scenario carries (default 1). */
  severity?: Readonly<Record<string, number>>;
  /** The declared scope; every demo Locale when omitted. */
  scope?: readonly Locale[];
  /** One scenario per class for the one-Locale `en` fixture. */
  classes?: readonly ScenarioClass[];
} = {}): Certificate {
  const perLocale = options.callsPerLocale ?? 3;
  const failing = new Set(options.failing ?? []);
  const severity = options.severity ?? {};
  const levels = Math.max(1, ...Object.values(severity));
  const scope = options.scope ?? LOCALES;
  const inScope = LOCALES.filter((locale) => scope.includes(locale));
  const rows = inScope.flatMap((locale) => {
    const classRows =
      locale === "en" && options.classes !== undefined
        ? options.classes.map((scenarioClass, index) => ({
            locale,
            scenario: `panel-en-${index + 1}`,
            class: scenarioClass,
            calls: Array.from(
              { length: perLocale },
              (_, callIndex) => `call-en-${index + 1}-${callIndex + 1}`,
            ),
          }))
        : [
            {
              locale,
              scenario: `panel-${locale}`,
              class: "golden-flow" as ScenarioClass,
              calls: Array.from(
                { length: perLocale },
                (_, index) => `call-${locale}-${index + 1}`,
              ),
            },
          ];
    const base = classRows.map((row) => ({
      ...row,
      heldOut: false,
      requiredRepetitions: perLocale,
      measuredRepetitions: perLocale,
      status: "measured" as const,
      gap: null,
    }));
    const extra = [...failing]
      .filter((name) => name === `fail-${locale}`)
      .map((name) => ({
        locale,
        scenario: name,
        class: "golden-flow" as ScenarioClass,
        heldOut: false,
        requiredRepetitions: 1,
        measuredRepetitions: 1,
        status: "measured" as const,
        gap: null,
        calls: [`call-${locale}-fail-1`],
      }));
    return [...base, ...extra];
  });
  const rowsByLocale = inScope.map((locale) => ({
    locale,
    rows: rows.filter((row) => row.locale === locale),
  }));
  const failedProperties = Array.from({ length: levels }, (_, level) => ({
    propertyId: `T${level + 1}`,
    family: "turn-taking" as const,
    status: "FAIL" as const,
    reason: "below-bar" as const,
    sampleCount: 1,
    citations: ["turn-taking"],
    gaps: [],
    scenarios: [...failing]
      .filter((scenario) => (severity[scenario] ?? 1) > level)
      .map((scenario) => ({
        scenario,
        locale: (scenario.split("-")[1] ?? "en") as Locale,
        status: "FAIL" as const,
        reason: "below-bar" as const,
        sampleCount: 1,
        citations: [`${scenario}#1`],
      })),
  }));
  const decision = {
    decidedBy: "owner" as const,
    decidedOn: "2026-11-02",
    reason: "English-only launch",
  };
  return {
    schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    runId: RUN_ID,
    target: "local",
    scope: {
      locales: inScope,
      ...decision,
    },
    code: {
      fingerprint: { head: "a".repeat(40), dirty: false, dirtyHash: "b".repeat(64) },
      appBuild: "app-build-1",
      pipelineImage: "pipeline-image-1",
    },
    corpus: { version: 1, sha256: "c".repeat(64) },
    vendorBuilds: [
      { leg: "stt", vendor: "vendor-a", model: "model-a", buildId: "build-a" },
      { leg: "tts", vendor: "vendor-b", model: "model-b", buildId: "build-b" },
      { leg: "llm", vendor: "vendor-c", model: "model-c", buildId: "build-c" },
    ],
    plan: { mode: "nightly", repetitions: perLocale },
    coverage: {
      expectedScenarios: rows.length,
      gapRows: 0,
      rows,
      byLocale: LOCALES.map((locale) => {
        const localeRows = rowsByLocale.find((entry) => entry.locale === locale);
        if (localeRows === undefined) {
          return {
            locale,
            expectedScenarios: 0,
            measuredScenarios: 0,
            gapRows: 0,
            status: "out-of-scope" as const,
            gap: null,
            decision,
          };
        }
        return {
          locale,
          expectedScenarios: localeRows.rows.length,
          measuredScenarios: localeRows.rows.length,
          gapRows: 0,
          status: "measured" as const,
          gap: null,
          decision: null,
        };
      }),
    },
    properties: failing.size === 0 ? [] : failedProperties,
    eligibility: { eligible: true, reasons: [] },
    runFailures: [],
    cost: { usd: 0.42, callCount: rows.reduce((sum, row) => sum + row.calls.length, 0) },
    residualRiskIds: [...OPEN_RESIDUAL_RISK_IDS],
    panel: null,
    resume: null,
    verdict: failing.size > 0 ? "not-demo-ready" : "pending-human",
    pass: false,
  };
}

/** Calls for every call the certificate's coverage names. */
export function callsFor(certificate: Certificate): RatingCallInput[] {
  return certificate.coverage.rows.flatMap((row) =>
    row.calls.map((callId) => call(callId, row.scenario, row.locale)),
  );
}

export function goldLabel(overrides: Partial<PanelGoldLabel> & { locale: Locale }): PanelGoldLabel {
  const { locale, axes: axisOverrides, ...rest } = overrides;
  return {
    sessionId: "rating-" + "a".repeat(64),
    callId: `call-${locale}-${Math.random().toString(16).slice(2)}`,
    itemId: `item-${Math.random().toString(16).slice(2)}`,
    scenario: `panel-${locale}`,
    locale,
    axes: {
      stayOnCall: 5,
      soundsHuman: 5,
      turnTaking: 5,
      understanding: 5,
      languageNaturalness: 5,
      warmth: 5,
      pacing: 5,
      ...(axisOverrides ?? {}),
    },
    humanDetected: overrides.humanDetected === undefined ? true : overrides.humanDetected,
    preference: overrides.preference === undefined ? "baseline" : overrides.preference,
    ratedAt: SESSION_DATE,
    ...rest,
  };
}

export function goldSet(labels: readonly PanelGoldLabel[]): PanelGoldLabelSet {
  return {
    sessionId: "rating-" + "a".repeat(64),
    runId: RUN_ID,
    reviewer: REVIEWER,
    signedAt: SESSION_DATE,
    labels,
    digest: "d".repeat(64),
  };
}

function h6Evidence(scenario: string) {
  return {
    propertyId: "H6",
    bars: [{ key: "dvJudgeKappaMin" as const, statistic: "each" as const, comparison: "at-least" as const }],
    measurements: [1, 2, 3].map((repetition) => ({
      propertyId: "H6",
      scenario,
      repetition,
      outcome: "measured" as const,
      samples: [0.9],
      citations: ["judge:panel-1"],
    })),
  };
}

function humanContract(contract: Awaited<ReturnType<typeof loadContract>>) {
  const properties = contract.properties.filter((entry) => /^H[1-7]$/.test(entry.id));
  return {
    families: contract.families.filter((family) => family.id === "human"),
    properties,
  };
}

function vendorBuilds() {
  return [
    { leg: "stt" as const, vendor: "vendor-a", model: "model-a", buildId: "build-a" },
    { leg: "tts" as const, vendor: "vendor-b", model: "model-b", buildId: "build-b" },
    { leg: "llm" as const, vendor: "vendor-c", model: "model-c", buildId: "build-c" },
  ];
}

export function buildSigningCertificate(input: {
  run: RunVerdict;
  panel: null | {
    sessionId: string;
    reviewer: string;
    signedAt: string;
    signature: string;
  };
  /** Defaults to every demo Locale; the English-only fixture declares `en`. */
  scope?: readonly Locale[];
  /** One scenario per Locale unless a one-Locale session needs twelve calls. */
  scenariosPerLocale?: number;
}): Certificate {
  const scope = input.scope ?? LOCALES;
  const classes: readonly ScenarioClass[] = [
    "golden-flow",
    "turn-taking",
    "comprehension",
    "emotion",
  ];
  const perLocale = input.scenariosPerLocale ?? 1;
  const scenarios = scope.flatMap((locale) =>
    Array.from({ length: perLocale }, (_, index) => ({
      name: perLocale === 1 ? `panel-${locale}` : `panel-${locale}-${index + 1}`,
      locale,
      heldOut: false,
      class: classes[index % classes.length]!,
    })),
  );
  const attempts = scenarios.flatMap((scenario) =>
    [1, 2, 3].map((repetition) => ({
      scenario: scenario.name,
      locale: scenario.locale,
      repetition,
      callId: `call-${scenario.name}-${repetition}`,
    })),
  );
  return buildCertificate({
    contract: humanContractSync(),
    run: input.run,
    target: "local",
    scope: {
      locales: [...scope],
      decidedBy: "owner",
      decidedOn: "2026-11-02",
      reason:
        scope.length === 1
          ? "English-only panel fixture"
          : "full five-Locale panel fixture",
    },
    plan: { mode: "nightly", repetitions: 3 },
    corpus: { version: 1, fingerprint: "c".repeat(64), scenarios },
    attempts,
    codeFingerprint: { head: "a".repeat(40), dirty: false, dirtyHash: "b".repeat(64) },
    appBuild: "app-build-1",
    pipelineImage: "pipeline-image-1",
    vendorBuilds: vendorBuilds(),
    cost: { usd: 0.42, callCount: attempts.length },
    residualRiskIds: [...OPEN_RESIDUAL_RISK_IDS],
    panel: input.panel,
  });
}

let cachedHumanContract: ReturnType<typeof humanContract> | null = null;
function humanContractSync() {
  if (cachedHumanContract === null) {
    throw new Error("call loadHumanContract() before building");
  }
  return cachedHumanContract;
}

export async function loadHumanContract() {
  cachedHumanContract = humanContract(await loadContract());
  return cachedHumanContract;
}

/**
 * A pending-human certificate and the one panel session the owner actually
 * rates: twelve calls, no accumulated-label ledger, and H1-H5 as the run
 * recorded them (unmeasured until the signature). H7 fails only because the
 * owner has not signed yet.
 */
export async function pendingSigningFixture(
  scope?: readonly Locale[],
): Promise<{
  certificate: Certificate;
  session: RatingSession;
  ratings: RatingRecord[];
  gold: PanelGoldLabelSet;
  calls: RatingCallInput[];
}> {
  const contract = await loadHumanContract();
  const baseRun = judgeRun({
    runId: RUN_ID,
    contract,
    evidence: [h6Evidence(scope?.length === 1 ? "panel-en-1" : "panel-en")],
  });
  const certificate = buildSigningCertificate({
    run: baseRun,
    panel: null,
    ...(scope === undefined ? {} : { scope }),
    ...(scope?.length === 1 ? { scenariosPerLocale: 4 } : {}),
  });

  const calls = callsFor(certificate);
  const { session } = buildPanelSession({
    certificate,
    calls,
    reviewer: REVIEWER,
    seed: 7,
    createdAt: "2026-10-31T10:00:00.000Z",
  });

  const ratings = session.queue.map((item) => {
    const axes = Object.fromEntries(RATING_AXES.map((axis) => [axis.id, 5]));
    return fileRating(
      session,
      {
        itemId: item.itemId,
        axes,
        humanSide: item.ab?.baselineSide ?? "A",
        preferredSide: item.ab?.baselineSide ?? "A",
      },
      "2026-10-31T11:00:00.000Z",
    );
  });

  return {
    certificate,
    session,
    ratings,
    gold: exportGoldLabels({ session, ratings }),
    calls,
  };
}
