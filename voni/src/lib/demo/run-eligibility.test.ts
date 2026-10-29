import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GATE_VOICE,
  STREAK_REQUIRED_GATES,
  buildSkeletonArtifact,
  judgeSubjectRun,
  type ScoreboardArtifact,
  type ScoreboardGate,
} from "./scoreboard";
import {
  GATE_CAPTURE_LEGS,
  deriveRunEligibility,
  type RunEventFact,
} from "./artifact-reader";
import { buildInspectReport, formatInspectReport } from "./scoreboard-report";

const CLEAN_CODE = { head: "a".repeat(40), dirty: false, dirtyHash: "0".repeat(64) };

/** Every required gate PASS, so nothing but eligibility can refuse the run. */
function requiredPassGates(overrides: Record<string, ScoreboardGate["status"]> = {}): ScoreboardGate[] {
  return STREAK_REQUIRED_GATES.map((name) => ({
    name,
    status: overrides[name] ?? "PASS",
    detail: "measured",
  })) as ScoreboardGate[];
}

function capture(name: string) {
  return { path: `artifacts/${name}.wav`, sha256: "a".repeat(64) };
}

/**
 * A run whose every number is in budget and whose every required gate PASSes.
 * Only the facts below it (events, captures, harness, fingerprint) can make it
 * ineligible; the numbers never do.
 */
function cleanRun(overrides: Partial<ScoreboardArtifact> = {}): ScoreboardArtifact {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 0,
    runs: 1,
    dryRun: true,
    runId: "run-clean-1",
    codeFingerprint: CLEAN_CODE,
    subject: {
      agent: { kind: "demo", voice: "anna", agentId: null },
      locale: "en",
      transport: "browser",
      source: "flag",
    },
    engine: {
      pipeline: "managed",
      run: {
        runId: "run-clean-1",
        variant: "managed",
        startedAt: "2026-10-29T10:00:00.000Z",
        finishedAt: "2026-10-29T10:00:03.000Z",
      },
      captures: {
        reference: capture("reference"),
        platform: capture("platform"),
        delivered: capture("delivered"),
      },
      eligibility: { eligible: true },
    },
  });
  return { ...artifact, gates: requiredPassGates(), ...overrides };
}

test("a fallback on any leg at any phase, connect included, makes a run ineligible", () => {
  const connect = deriveRunEligibility({
    artifact: cleanRun(),
    events: [{ type: "provider_fallback", leg: "llm", phase: "connect" }],
  });
  assert.equal(connect.eligible, false);
  assert.equal(connect.disposition, "rerun");
  assert.match(connect.reasons.join(" "), /fallback/);
  assert.match(connect.reasons.join(" "), /llm/);
  assert.match(connect.reasons.join(" "), /connect/);

  const midTurn = deriveRunEligibility({
    artifact: cleanRun(),
    events: [{ type: "provider_fallback", leg: "stt", phase: "turn", turn: "turn-4" }],
  });
  assert.equal(midTurn.eligible, false, "a mid-turn fallback is not a different fact from a connect one");
  assert.match(midTurn.reasons.join(" "), /turn-4/);

  const crossing = deriveRunEligibility({
    artifact: cleanRun(),
    events: [{ type: "budget.crossing", phase: "turn" }],
  });
  assert.equal(crossing.eligible, true, "an 80% crossing is not a budget stop");
});

test("a budget stop, a missing capture, a harness failure and a fingerprint mismatch each refuse green", () => {
  const budgetStop = deriveRunEligibility({
    artifact: cleanRun(),
    events: [{ type: "budget.stopped", phase: "drain" }],
  });
  assert.equal(budgetStop.eligible, false);
  assert.match(budgetStop.reasons.join(" "), /budget stop/);

  const artifact = cleanRun();
  artifact.captures = undefined;
  const missingCapture = deriveRunEligibility({ artifact });
  assert.equal(missingCapture.eligible, false);
  assert.match(missingCapture.reasons.join(" "), /timbre-probes/);
  assert.match(missingCapture.reasons.join(" "), /delivered/);
  assert.deepEqual(GATE_CAPTURE_LEGS["timbre-probes"], ["reference", "delivered"]);

  const brokenHarness = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 1,
    durationMs: 0,
    runs: 1,
    dryRun: false,
    runId: "run-broken-1",
    codeFingerprint: CLEAN_CODE,
  });
  const harnessFailure = deriveRunEligibility({ artifact: { ...brokenHarness, gates: requiredPassGates() } });
  assert.equal(harnessFailure.eligible, false);
  assert.match(harnessFailure.reasons.join(" "), /harness/);

  const noFingerprint = deriveRunEligibility({ artifact: cleanRun({ codeFingerprint: null }) });
  assert.equal(noFingerprint.eligible, false);
  assert.match(noFingerprint.reasons.join(" "), /no code fingerprint/);

  const dirty = deriveRunEligibility({ artifact: cleanRun({ codeFingerprint: { ...CLEAN_CODE, dirty: true } }) });
  assert.equal(dirty.eligible, false);
  assert.match(dirty.reasons.join(" "), /dirty/);

  const elsewhere = deriveRunEligibility({
    artifact: cleanRun(),
    expectedCode: { head: "b".repeat(40) },
  });
  assert.equal(elsewhere.eligible, false);
  assert.match(elsewhere.reasons.join(" "), /differs/);
});

test("a run the artifact itself marks ineligible keeps its named reason", () => {
  const verdict = deriveRunEligibility({
    artifact: cleanRun({ eligibility: { eligible: false, reasons: ["the ledger refuses the run"] } }),
  });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reasons.join(" "), /the ledger refuses the run/);
});

test("a contaminated run is ineligible even with every number in budget and every gate PASS", () => {
  const contaminated = cleanRun({
    events: [{ type: "provider_fallback", leg: "llm", phase: "connect" }],
  });
  // The run's own flag says eligible; the facts say otherwise. Green must not
  // be reachable from the flag alone.
  assert.deepEqual(contaminated.eligibility, { eligible: true });

  const report = buildInspectReport(contaminated);
  assert.equal(report.verdict.eligible, false);
  assert.equal(report.verdict.kind, "ineligible");
  assert.equal(report.verdict.green, false, "removing the eligibility check would make this run green");
  assert.equal(report.verdict.disposition, "rerun");
  assert.equal(
    report.verdict.countsTowardKillCriterion,
    false,
    "a contaminated run is re-run, not counted",
  );

  const printed = formatInspectReport(report);
  assert.match(printed, /verdict\s+INELIGIBLE/);
  assert.match(printed, /re-run/);
  assert.match(printed, /provider fallback/);
});

test("a clean run whose required gates all PASS is green and counts", () => {
  const report = buildInspectReport(cleanRun());
  assert.equal(report.verdict.kind, "green");
  assert.equal(report.verdict.green, true);
  assert.equal(report.verdict.disposition, "counts");
  assert.equal(report.verdict.countsTowardKillCriterion, true);
  assert.deepEqual(report.verdict.failedGates, []);
  assert.match(formatInspectReport(report), /verdict\s+green/);
});

test("a clean run that fails a required gate is red, not green, and still counts", () => {
  const red = cleanRun({ gates: requiredPassGates({ "reply-gap": "FAIL" }) });
  const report = buildInspectReport(red);
  assert.equal(report.verdict.kind, "red");
  assert.equal(report.verdict.green, false);
  assert.deepEqual(report.verdict.failedGates, ["reply-gap"]);
  assert.equal(report.verdict.countsTowardKillCriterion, true);
  assert.match(formatInspectReport(report), /verdict\s+red/);
});

test("an eligible flag without a clean fact set cannot green a run", () => {
  const verdict = judgeSubjectRun({
    gates: requiredPassGates(),
    eligibility: { eligible: false, reasons: ["a budget stop ended the call"] },
  });
  assert.equal(verdict.kind, "ineligible");
  assert.equal(verdict.green, false);
  assert.equal(verdict.countsTowardKillCriterion, false);
  assert.deepEqual(verdict.reasons, ["a budget stop ended the call"]);

  const events: RunEventFact[] = [{ type: "provider_fallback", leg: "tts", phase: "turn", turn: "t2" }];
  assert.equal(deriveRunEligibility({ artifact: cleanRun(), events }).eligible, false);
});
