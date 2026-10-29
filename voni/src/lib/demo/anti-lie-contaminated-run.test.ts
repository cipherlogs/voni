import test from "node:test";
import assert from "node:assert/strict";
import {
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  DEFAULT_GATE_VOICE,
  STREAK_REQUIRED_GATES,
  buildSkeletonArtifact,
  judgeSubjectRun,
  type ScoreboardArtifact,
  type ScoreboardGate,
} from "./scoreboard";
import {
  ArtifactReadError,
  deriveRunEligibility,
  parseScoreboardArtifact,
  type RunEventFact,
} from "./artifact-reader";
import { buildInspectReport, formatInspectReport } from "./scoreboard-report";

/**
 * Anti-lie: a fallback-contaminated run cannot be green (M4/M18, ticket 143).
 *
 * Every fixture here is a *green candidate*: all required gates PASS and its
 * own eligibility flag says eligible. Only the run's facts below it (events,
 * captures, harness) can refuse green, so a gate that ignores one of them
 * turns a contaminated run green and fails this file.
 */

const CLEAN_CODE = { head: "a".repeat(40), dirty: false, dirtyHash: "0".repeat(64) };

/** Every required gate PASS, so nothing but a run fact can refuse green. */
function requiredPassGates(): ScoreboardGate[] {
  return STREAK_REQUIRED_GATES.map((name) => ({
    name,
    status: "PASS",
    detail: "measured",
  })) as ScoreboardGate[];
}

function capture(name: string) {
  return { path: `artifacts/${name}.wav`, sha256: "a".repeat(64) };
}

/**
 * A cascade artifact carrying the one shared shape (M12) whose numbers and
 * gates are all green. The caller adds the one contamination.
 */
function greenCandidate(overrides: Partial<ScoreboardArtifact> = {}): ScoreboardArtifact {
  const base = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 3000,
    runs: 1,
    dryRun: true,
    runId: "run-contaminated-1",
    codeFingerprint: CLEAN_CODE,
    subject: {
      agent: { kind: "demo", voice: "anna", agentId: null },
      locale: "en",
      transport: "browser",
      source: "flag",
    },
  });
  return {
    ...base,
    pipeline: "cascade",
    run: {
      runId: base.runId,
      variant: "cascade-anna-1",
      startedAt: "2026-10-29T10:00:00.000Z",
      finishedAt: "2026-10-29T10:00:03.000Z",
    },
    providers: { stt: "meta", llm: "spark", tts: "assemblyai" },
    latency: {
      screenToFirstPartialMs: 180,
      speechCompleteToFirstTokenMs: 240,
      replyGapP50Ms: 900,
      commitToFirstPlayoutMs: { absent: "N/A — the cascade has no commit mark" },
    },
    cost: {
      currency: "USD",
      rateTableVersion: "rates-2026-10-29",
      legs: { stt: 0.0031, llm: 0.0024, tts: 0.0045 },
      total: 0.01,
    },
    captures: {
      reference: capture("reference"),
      platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
      delivered: capture("delivered"),
    },
    eligibility: { eligible: true },
    gates: requiredPassGates(),
    ...overrides,
  };
}

function event(overrides: RunEventFact & { type: string }): RunEventFact {
  return overrides;
}

/** The verdict the one report path derives for a run, never a hand-written one. */
function verdictFor(artifact: ScoreboardArtifact) {
  return buildInspectReport(artifact).verdict;
}

const CONTAMINATIONS: readonly {
  readonly name: string;
  readonly contaminate: () => ScoreboardArtifact;
  readonly why: RegExp;
}[] = [
  {
    name: "a fallback at connect",
    contaminate: () =>
      greenCandidate({
        events: [event({ type: "provider_fallback", leg: "llm", phase: "connect", turn: null })],
      }),
    why: /provider fallback .*leg llm.*at connect/,
  },
  {
    name: "a fallback mid-turn",
    contaminate: () =>
      greenCandidate({
        events: [
          event({ type: "provider_fallback", leg: "stt", phase: "turn", turn: "turn-4" }),
        ],
      }),
    why: /provider fallback .*leg stt.*at turn.*turn turn-4/,
  },
  {
    name: "a budget stop",
    contaminate: () =>
      greenCandidate({ events: [event({ type: "budget.stopped", phase: "drain" })] }),
    why: /budget stop/,
  },
  {
    name: "a missing delivered capture",
    contaminate: () => {
      const artifact = greenCandidate();
      const captures = { ...artifact.captures } as Record<string, unknown>;
      delete captures.delivered;
      return { ...artifact, captures } as ScoreboardArtifact;
    },
    why: /delivered capture is missing/,
  },
  {
    name: "a harness failure",
    contaminate: () => {
      const broken = buildSkeletonArtifact({
        voice: DEFAULT_GATE_VOICE,
        scenario: "stop-over",
        runnerStdout: "",
        exitCode: 1,
        durationMs: 0,
        runs: 1,
        dryRun: false,
        runId: "run-harness-broken",
        codeFingerprint: CLEAN_CODE,
      });
      return { ...greenCandidate({ runId: "run-harness-broken" }), evalRunner: broken.evalRunner };
    },
    why: /harness failure/,
  },
];

test("a green candidate is green only when no fact contaminates it", () => {
  const verdict = verdictFor(greenCandidate());

  assert.equal(verdict.kind, "green");
  assert.equal(verdict.green, true);
  assert.equal(verdict.disposition, "counts");
  assert.deepEqual(verdict.reasons, []);
  // The numbers and gates were never the reason it is green: the same gates
  // and same flag on a contaminated run are not enough below.
  assert.deepEqual(verdict.failedGates, []);
});

for (const { name, contaminate, why } of CONTAMINATIONS) {
  test(`${name} cannot be green, and the verdict says why`, () => {
    const artifact = contaminate();

    // The artifact's own flag and every gate still claim green. Green must not
    // be reachable from either when a run fact refuses it.
    assert.deepEqual(artifact.eligibility, { eligible: true });
    assert.deepEqual(
      artifact.gates.filter((gate) => (STREAK_REQUIRED_GATES as readonly string[]).includes(gate.name))
        .filter((gate) => gate.status !== "PASS"),
      [],
    );

    const verdict = verdictFor(artifact);
    assert.equal(verdict.green, false, `${name} turned green`);
    assert.equal(verdict.kind, "ineligible");
    assert.equal(verdict.countsTowardKillCriterion, false, "a contaminated run is re-run, not counted");
    assert.match(verdict.reasons.join(" "), why);

    const printed = formatInspectReport(buildInspectReport(artifact));
    assert.match(printed, /verdict\s+INELIGIBLE/);
    assert.match(printed, /re-run/);
  });
}

test("an artifact that claims green while contaminated is refused by field", () => {
  const lying = greenCandidate({
    events: [event({ type: "provider_fallback", leg: "llm", phase: "connect", turn: null })],
    eligibility: { eligible: true },
  });

  assert.throws(
    () => parseScoreboardArtifact(lying, "lying-cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "eligibility.eligible" &&
      /provider_fallback/.test(error.message) &&
      /fallback-contaminated/.test(error.message),
  );

  const budgetLiar = greenCandidate({
    events: [event({ type: "budget.stopped", phase: "drain" })],
  });
  assert.throws(
    () => parseScoreboardArtifact(budgetLiar, "budget-liar.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "eligibility.eligible" &&
      /budget stop/.test(error.message),
  );
});

test("an honest contaminated artifact still parses, and the gate refuses it green", () => {
  const honest = greenCandidate({
    events: [event({ type: "provider_fallback", leg: "llm", phase: "connect", turn: null })],
    eligibility: {
      eligible: false,
      reasons: ["provider fallback (leg llm, at connect); a fallback-contaminated run is not a clean run"],
    },
  });

  const parsed = parseScoreboardArtifact(honest, "honest-cascade.json");
  const verdict = verdictFor(parsed);
  assert.equal(verdict.green, false);
  assert.equal(verdict.kind, "ineligible");
  assert.match(verdict.reasons.join(" "), /provider fallback/);
});

test("the only thing between a contaminated all-PASS run and green is the derived eligibility", () => {
  // Reproduce what a gate that ignored the fallback event would decide: the
  // artifact's own flag says eligible and every required gate PASSes. The
  // derived verdict is what refuses it, so deleting that derivation (or its
  // fallback branch) turns this run green.
  const artifact = greenCandidate({
    events: [event({ type: "provider_fallback", leg: "llm", phase: "connect", turn: null })],
  });

  const numbersOnly = judgeSubjectRun({
    gates: artifact.gates,
    eligibility: artifact.eligibility ?? { eligible: false },
  });
  assert.equal(numbersOnly.kind, "green", "the fixture is only meaningful while the flag alone greens it");

  assert.equal(deriveRunEligibility({ artifact }).eligible, false);
  assert.equal(verdictFor(artifact).green, false);
});
