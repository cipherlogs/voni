import assert from "node:assert/strict";
import test from "node:test";

import type { Contract, ContractPropertyEntry } from "../contract";
import { LOCALES } from "../scenarios";
import {
  OPEN_RESIDUAL_RISK_IDS,
  deriveCertificateVerdict,
  buildCertificate,
  type Certificate,
  type CertificateBuildInput,
  type CertificateTarget,
  type PanelSignature,
  type VendorBuild,
} from "../certificate";
import { judgeRun, type PropertyEvidence, type PropertyMeasurement } from "../verdict";
import {
  MONTHLY_PRODUCTION_CRON,
  POST_FLIP_MAX_CALLS,
  ROLLBACK_ROUTING_MODE,
  STREAK_SIZE,
  evaluateCertificateStreak,
  evaluateCutoverGate,
  isCleanCertification,
  evaluateMonthlyProduction,
  evaluatePostFlipConfirmation,
  evaluateRollback,
  monthlyProductionRecord,
  parsePostFlipConfirmation,
  parseRollbackRecord,
  assertProductionCertificate,
  type PostFlipConfirmation,
} from "./index";

/**
 * Ticket 29: three consecutive clean certifications gate a release, a staging
 * certificate for the same image gates the flip, the post-flip confirmation is
 * recorded and short, rollback is one routing value with zero new vendor
 * sessions, and the monthly production full is scheduled and recorded.
 */

const FINGERPRINT = {
  head: "a".repeat(40),
  dirty: false,
  dirtyHash: "b".repeat(64),
};

const CORPUS_HASH = "c".repeat(64);
const IMAGE = `sha256:${"d".repeat(64)}`;

const PANEL: PanelSignature = {
  sessionId: "rating-" + "e".repeat(64),
  reviewer: "owner",
  signedAt: "2026-10-31",
  signature: "panel-v1:" + "f".repeat(64),
};

const VENDOR_BUILDS: readonly VendorBuild[] = [
  { leg: "stt", vendor: "assemblyai", model: "best", buildId: "stt-build-1" },
  { leg: "tts", vendor: "cartesia", model: "sonic", buildId: "tts-build-1" },
  { leg: "llm", vendor: "openai", model: "fast-model", buildId: "llm-build-1" },
];

const T1: ContractPropertyEntry = {
  id: "T1",
  family: "turn-taking",
  statement: "First response follows the caller's turn end",
  bar: { text: "p50 <= 350 ms", numeric: true },
  evidence: "ledger",
  kind: "timing",
  repetitions: 1,
  thresholds: [{ source: "budget-record", key: "p50", value: 350, unit: "ms" }],
};

const C9: ContractPropertyEntry = {
  id: "C9",
  family: "conduct",
  statement: "Answers honestly when asked whether it is an AI",
  bar: { text: "pass", numeric: false },
  evidence: "ledger",
  kind: "behaviour",
  repetitions: 1,
  thresholds: [],
};

const CONTRACT: Contract = {
  families: [
    { id: "turn-taking", title: "Turn taking", propertyCount: 1 },
    { id: "conduct", title: "Conduct", propertyCount: 1 },
  ],
  properties: [T1, C9],
};

const SCENARIOS = LOCALES.map((locale) => ({
  name: `hello-${locale}`,
  locale,
  heldOut: false,
}));

function attempts(): NonNullable<CertificateBuildInput["attempts"]> {
  return SCENARIOS.map((scenario) => ({
    scenario: scenario.name,
    locale: scenario.locale,
    repetition: 1,
    callId: `call-${scenario.name}`,
  }));
}

function evidence(): PropertyEvidence[] {
  const numeric: PropertyMeasurement[] = [];
  const categorical: PropertyMeasurement[] = [];
  for (const scenario of SCENARIOS) {
    const citation = `call:${scenario.name}#1`;
    numeric.push({
      propertyId: "T1",
      scenario: scenario.name,
      repetition: 1,
      locale: scenario.locale,
      outcome: "measured",
      samples: [120],
      citations: [citation],
    });
    categorical.push({
      propertyId: "C9",
      scenario: scenario.name,
      repetition: 1,
      locale: scenario.locale,
      outcome: "measured",
      samples: [],
      passed: true,
      citations: [citation],
    });
  }
  return [
    {
      propertyId: "T1",
      bars: [{ key: "p50", statistic: "p50", comparison: "at-most" }],
      measurements: numeric,
    },
    { propertyId: "C9", bars: [], measurements: categorical },
  ];
}

type CertificateOptions = {
  readonly runId: string;
  readonly target?: CertificateTarget;
  readonly fingerprint?: typeof FINGERPRINT;
  readonly image?: string;
  readonly panel?: PanelSignature | null;
  readonly resume?: NonNullable<CertificateBuildInput["resume"]>;
};

function certificate(options: CertificateOptions): Certificate {
  const run = judgeRun({
    runId: options.runId,
    contract: CONTRACT,
    evidence: evidence(),
    calls: [],
  });
  return buildCertificate({
    contract: CONTRACT,
    run,
    target: options.target ?? "staging",
    plan: { mode: "full", repetitions: 1 },
    corpus: { version: 1, fingerprint: CORPUS_HASH, scenarios: SCENARIOS },
    attempts: attempts(),
    codeFingerprint: options.fingerprint ?? FINGERPRINT,
    appBuild: (options.fingerprint ?? FINGERPRINT).head,
    pipelineImage: options.image ?? IMAGE,
    vendorBuilds: VENDOR_BUILDS,
    cost: { usd: 1.25, callCount: 5 },
    residualRiskIds: [...OPEN_RESIDUAL_RISK_IDS],
    panel: options.panel === undefined ? PANEL : options.panel,
    resume: options.resume ?? null,
  });
}

function unready(base: Certificate): Certificate {
  return {
    ...base,
    verdict: "not-demo-ready",
    pass: false,
    coverage: { ...base.coverage, gapRows: 1 },
  };
}

function pendingHuman(base: Certificate): Certificate {
  return {
    ...base,
    panel: null,
    verdict: "pending-human",
    pass: false,
  };
}

const STAGING_1 = certificate({ runId: "run-2026-10-01-01" });
const STAGING_2 = certificate({ runId: "run-2026-10-02-01" });
const STAGING_3 = certificate({ runId: "run-2026-10-03-01" });

test("three consecutive clean certifications on one fingerprint and target form a streak", () => {
  assert.equal(STREAK_SIZE, 3);
  const result = evaluateCertificateStreak({
    certificates: [STAGING_1, STAGING_2, STAGING_3],
    target: "staging",
  });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.runIds, [STAGING_1.runId, STAGING_2.runId, STAGING_3.runId]);
  assert.deepEqual(result.fingerprint, FINGERPRINT);
  assert.match(result.detail, /3 consecutive clean/);
});

test("a dirty hash that moved while HEAD and the dirty flag stayed put breaks the streak", () => {
  const one = certificate({
    runId: "run-2026-10-05-01",
    fingerprint: { ...FINGERPRINT, dirty: true, dirtyHash: "1".repeat(64) },
  });
  const two = certificate({
    runId: "run-2026-10-05-02",
    fingerprint: { ...FINGERPRINT, dirty: true, dirtyHash: "2".repeat(64) },
  });
  const sameAgain = certificate({
    runId: "run-2026-10-05-03",
    fingerprint: { ...FINGERPRINT, dirty: true, dirtyHash: "2".repeat(64) },
  });
  const streak = evaluateCertificateStreak({
    certificates: [one, two, sameAgain],
    target: "staging",
  });
  assert.equal(streak.ok, false);
  assert.ok(
    streak.breaks.some((entry) => entry.code === "different-fingerprint"),
    "a dirty-hash-only divergence is a different fingerprint",
  );
});

test("a resumed certificate is not a clean certification for the streak or the gate", () => {
  const resumed = certificate({
    runId: "run-2026-10-03-02",
    resume: {
      journalRunId: "run-2026-10-01-01",
      journalPath: "/tmp/runs/run-2026-10-01-01/journal.jsonl",
      originalStartedAt: "2026-10-01T08:00:00.000Z",
      resumedAt: "2026-10-01T10:00:00.000Z",
      reusedCalls: ["call-hello-en"],
      madeCalls: ["call-hello-es"],
    },
  });
  assert.equal(isCleanCertification(resumed), false);

  const streak = evaluateCertificateStreak({
    certificates: [STAGING_2, STAGING_3, resumed],
    target: "staging",
  });
  assert.equal(streak.ok, false);
  assert.ok(streak.breaks.some((entry) => entry.code === "resumed-run"));
  assert.match(streak.detail, /resumed-run/);

  const gate = evaluateCutoverGate({
    image: IMAGE,
    certificates: [STAGING_1, STAGING_2, resumed],
  });
  assert.equal(gate.open, false);
  const cleanCheck = gate.checks.find((check) => check.name === "staging-clean");
  assert.equal(cleanCheck?.ok, false);
  assert.match(cleanCheck?.detail ?? "", /interruption|resumed/i);
});

test("a dirty tree, a coverage gap, a different target or a different fingerprint breaks the streak", () => {
  const dirty = certificate({
    runId: "run-2026-10-04-01",
    fingerprint: { ...FINGERPRINT, dirty: true, dirtyHash: "9".repeat(64) },
  });
  const dirtyStreak = evaluateCertificateStreak({
    certificates: [STAGING_2, STAGING_3, dirty],
    target: "staging",
  });
  assert.equal(dirtyStreak.ok, false);
  assert.ok(dirtyStreak.breaks.some((entry) => entry.code === "dirty-tree"));

  const gapped = unready(STAGING_3);
  const gapStreak = evaluateCertificateStreak({
    certificates: [STAGING_1, STAGING_2, gapped],
    target: "staging",
  });
  assert.equal(gapStreak.ok, false);
  assert.ok(gapStreak.breaks.some((entry) => entry.code === "coverage-gap"));

  const production = certificate({ runId: "run-2026-10-04-02", target: "production" });
  const targetStreak = evaluateCertificateStreak({
    certificates: [STAGING_2, STAGING_3, production],
    target: "staging",
  });
  assert.equal(targetStreak.ok, false);
  assert.ok(targetStreak.breaks.some((entry) => entry.code === "different-target"));

  const moved = certificate({
    runId: "run-2026-10-04-03",
    fingerprint: { ...FINGERPRINT, head: "1".repeat(40), dirtyHash: "2".repeat(64) },
  });
  const movedStreak = evaluateCertificateStreak({
    certificates: [STAGING_2, STAGING_3, moved],
    target: "staging",
  });
  assert.equal(movedStreak.ok, false);
  assert.ok(movedStreak.breaks.some((entry) => entry.code === "different-fingerprint"));
});

test("fewer than three certifications, or a non-certified run between them, is not a streak", () => {
  const short = evaluateCertificateStreak({
    certificates: [STAGING_1, STAGING_2],
    target: "staging",
  });
  assert.equal(short.ok, false);
  assert.equal(short.count, 2);
  assert.match(short.detail, /3/);

  const interrupted = evaluateCertificateStreak({
    certificates: [STAGING_1, unready(STAGING_2), STAGING_3],
    target: "staging",
  });
  assert.equal(interrupted.ok, false);
  assert.ok(interrupted.breaks.some((entry) => entry.code === "not-certified"));
});

test("an unsigned panel property is pending-human only when it was not measured", () => {
  const base = STAGING_1;
  const withH = (reason: "no-evaluator" | "below-bar") => ({
    ...base,
    panel: null,
    verdict: "pending-human" as const,
    pass: false,
    properties: [
      {
        ...base.properties[0],
        propertyId: "H1",
        family: "human",
        status: "FAIL" as const,
        reason,
        citations: ["panel:item-1"],
      },
    ],
  });
  const pending = withH("no-evaluator");
  assert.equal(
    deriveCertificateVerdict({
      eligibility: pending.eligibility,
      properties: pending.properties,
      runFailures: pending.runFailures,
      coverage: pending.coverage,
      panel: null,
    }),
    "pending-human",
  );
  const failed = withH("below-bar");
  assert.equal(
    deriveCertificateVerdict({
      eligibility: failed.eligibility,
      properties: failed.properties,
      runFailures: failed.runFailures,
      coverage: failed.coverage,
      panel: null,
    }),
    "not-demo-ready",
    "a measured panel failure is never excused as pending-human",
  );
});

test("the cutover gate opens only on a clean staging certificate for the same image plus a streak", () => {
  const gate = evaluateCutoverGate({
    image: IMAGE,
    certificates: [STAGING_1, STAGING_2, STAGING_3],
  });
  assert.equal(gate.open, true);
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.stagingRunId, STAGING_3.runId);
  assert.ok(gate.checks.every((check) => check.ok));
  assert.ok(
    gate.checks.some(
      (check) => check.name === "production-inheritance" && /own certificate|never inherited/.test(check.detail),
    ),
  );
});

test("the gate names the missing evidence when there is no staging certificate for the image", () => {
  const gate = evaluateCutoverGate({
    image: `sha256:${"7".repeat(64)}`,
    certificates: [STAGING_1, STAGING_2, STAGING_3],
  });
  assert.equal(gate.open, false);
  assert.equal(gate.exitCode, 2);
  assert.ok(gate.missing.some((item) => /staging certificate for image/.test(item)));
  assert.ok(gate.missing.some((item) => item.includes("7".repeat(64))));
});

test("an unsigned or failing staging certificate blocks the flip by name (pending-human is exit 3)", () => {
  const pending = pendingHuman(STAGING_3);
  const gate = evaluateCutoverGate({
    image: IMAGE,
    certificates: [STAGING_1, STAGING_2, pending],
  });
  assert.equal(gate.open, false);
  assert.equal(gate.exitCode, 3);
  assert.match(gate.detail, /pending-human/i);

  const red = unready(STAGING_3);
  const redGate = evaluateCutoverGate({
    image: IMAGE,
    certificates: [STAGING_1, STAGING_2, red],
  });
  assert.equal(redGate.open, false);
  assert.equal(redGate.exitCode, 1);
});

test("a production certificate never inherits a staging green", () => {
  assert.throws(
    () => assertProductionCertificate(STAGING_3),
    /production/,
    "a staging certificate cannot be read as a production one",
  );
  const production = certificate({ runId: "run-2026-10-04-04", target: "production" });
  assert.doesNotThrow(() => assertProductionCertificate(production));

  // A production certificate is not staging evidence for the gate either.
  const gate = evaluateCutoverGate({
    image: IMAGE,
    certificates: [production, production, production],
  });
  assert.equal(gate.exitCode, 2);
  assert.match(gate.detail, /staging certificate/);
});

function confirmation(overrides: Partial<PostFlipConfirmation> = {}): PostFlipConfirmation {
  const calls = Array.from({ length: POST_FLIP_MAX_CALLS }, (_, index) => ({
    callId: `flip-call-${index + 1}`,
    scenario: `golden-flow-${index + 1}`,
    locale: "en" as const,
  }));
  return {
    schemaVersion: 1,
    target: "production",
    image: IMAGE,
    runId: "flip-2026-10-31-01",
    stagingCertificateRunId: STAGING_3.runId,
    flippedAt: "2026-10-31T09:00:00.000Z",
    confirmedAt: "2026-10-31T09:07:00.000Z",
    calls,
    verdict: "passed",
    evidence: ["voni/.demo-runs/flip-2026-10-31-01"],
    detail: "ten-call fast contract after the flip",
    ...overrides,
  };
}

test("the post-flip confirmation is recorded, short and bound to the staging gate", () => {
  const record = parsePostFlipConfirmation(confirmation());
  assert.equal(record.calls.length, POST_FLIP_MAX_CALLS);
  const evaluated = evaluatePostFlipConfirmation(record, {
    image: IMAGE,
    stagingCertificateRunId: STAGING_3.runId,
  });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.exitCode, 0);

  const long = parsePostFlipConfirmation(
    confirmation({
      calls: Array.from({ length: POST_FLIP_MAX_CALLS + 1 }, (_, index) => ({
        callId: `flip-call-${index + 1}`,
        scenario: `golden-flow-${index + 1}`,
        locale: "en" as const,
      })),
    }),
  );
  const longEvaluated = evaluatePostFlipConfirmation(long, {
    image: IMAGE,
    stagingCertificateRunId: STAGING_3.runId,
  });
  assert.equal(longEvaluated.exitCode, 2);
  assert.match(longEvaluated.detail, /short|10/);
});

test("a confirmation for a different image or a different staging gate is refused by name", () => {
  const record = parsePostFlipConfirmation(confirmation());
  const wrongImage = evaluatePostFlipConfirmation(record, {
    image: `sha256:${"8".repeat(64)}`,
    stagingCertificateRunId: STAGING_3.runId,
  });
  assert.equal(wrongImage.exitCode, 2);
  assert.match(wrongImage.detail, /image/);

  const wrongGate = evaluatePostFlipConfirmation(record, {
    image: IMAGE,
    stagingCertificateRunId: "run-other",
  });
  assert.equal(wrongGate.exitCode, 2);
  assert.match(wrongGate.detail, /staging certificate/);
});

test("rollback is one routing value and its proof produces zero new vendor sessions", () => {
  assert.equal(ROLLBACK_ROUTING_MODE, "off");
  const record = parseRollbackRecord({
    schemaVersion: 1,
    mode: "off",
    at: "2026-10-31T10:00:00.000Z",
    operator: "operator",
    callId: "flip-call-1",
    refusedCode: "managed",
    newVendorSessions: 0,
  });
  const evaluated = evaluateRollback(record);
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.exitCode, 0);
  assert.equal(evaluated.value, "off");

  assert.throws(
    () =>
      parseRollbackRecord({
        schemaVersion: 1,
        mode: "off",
        at: "2026-10-31T10:00:00.000Z",
        operator: "operator",
        callId: "flip-call-1",
        refusedCode: "managed",
        newVendorSessions: 1,
      }),
    /vendor session/,
  );
  assert.throws(
    () =>
      parseRollbackRecord({
        schemaVersion: 1,
        mode: "demo",
        at: "2026-10-31T10:00:00.000Z",
        operator: "operator",
        callId: "flip-call-1",
        refusedCode: "managed",
        newVendorSessions: 0,
      }),
    /one routing value|off/,
  );

  const missing = evaluateRollback(null);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.detail, /kill-switch proof/);
});

test("the monthly full production certification is scheduled and recorded, or refused pending-human", () => {
  const empty = monthlyProductionRecord();
  assert.equal(empty.cron, MONTHLY_PRODUCTION_CRON);
  const pending = evaluateMonthlyProduction({
    record: empty,
    certificates: [],
    now: new Date("2026-10-31T12:00:00.000Z"),
  });
  assert.equal(pending.exitCode, 3);
  assert.match(pending.detail, /pending-human/);
  assert.match(pending.detail, /production/);

  const production = certificate({
    runId: "run-2026-10-05-01",
    target: "production",
    image: IMAGE,
  });
  const recorded = {
    ...empty,
    entries: [
      {
        month: "2026-10",
        runId: production.runId,
        image: IMAGE,
        fingerprint: FINGERPRINT,
        certifiedAt: "2026-10-05T08:00:00.000Z",
      },
    ],
  };
  const current = evaluateMonthlyProduction({
    record: recorded,
    certificates: [production],
    now: new Date("2026-10-31T12:00:00.000Z"),
  });
  assert.equal(current.exitCode, 0);
  assert.match(current.detail, /current/);

  const overdue = evaluateMonthlyProduction({
    record: recorded,
    certificates: [production],
    now: new Date("2026-12-15T12:00:00.000Z"),
  });
  assert.equal(overdue.exitCode, 1);
  assert.match(overdue.detail, /overdue/);

  const unrecorded = evaluateMonthlyProduction({
    record: { ...empty, cron: "0 0 * * *" },
    certificates: [],
    now: new Date("2026-10-31T12:00:00.000Z"),
  });
  assert.equal(unrecorded.exitCode, 2);
  assert.ok(unrecorded.detail.includes(MONTHLY_PRODUCTION_CRON));
});
