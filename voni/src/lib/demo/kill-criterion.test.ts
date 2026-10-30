/**
 * Small samples, measured rounds and the kill criterion (meta-cascade M13,
 * ticket 119).
 *
 * The kill criterion is a property of the evidence, not of an invocation: a
 * measured round is two subjects with two consecutive clean runs each, a
 * contaminated attempt is re-run and never counted, three measured rounds
 * failing the frozen reply-gap median stop the automatic cutover, and a round
 * that passes the reply gap but fails another required gate blocks the cutover
 * without killing the work. An owner risk acceptance is a dated record that
 * carries the evidence — it is never a `PASS`.
 *
 * Expected numbers come from the committed budget record, not from this file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSkeletonArtifact,
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  DEFAULT_GATE_VOICE,
  STREAK_REQUIRED_GATES,
  replyGapGate,
  type CodeFingerprint,
  type ScoreboardArtifact,
  type ScoreboardGate,
} from "./scoreboard";
import { resolveCascadeSubject, type SubjectRecord } from "./subject";
import {
  KILL_CRITERION_ROUNDS,
  MIN_SAMPLES_FOR_P50,
  evaluateKillCriterion,
  judgeReplyGapScope,
  type RoundInput,
} from "./kill-criterion";

const BUDGET_RECORD = JSON.parse(
  readFileSync(new URL("./scoreboard-budgets.json", import.meta.url), "utf8"),
) as { budgets: Record<string, number> };

const P50 = BUDGET_RECORD.budgets.replyGapP50Ms;
const P95 = BUDGET_RECORD.budgets.replyGapP95Ms;

const CLEAN_CODE: CodeFingerprint = {
  head: "a".repeat(40),
  dirty: false,
  dirtyHash: "0".repeat(64),
};

const ANNA = resolveCascadeSubject({ voice: DEFAULT_GATE_VOICE });
const LOLA = resolveCascadeSubject({ voice: "lola" });

const PASS_GATES: ScoreboardGate[] = STREAK_REQUIRED_GATES.map((name) => ({
  name,
  status: "PASS",
  detail: "measured",
}));

function capture(name: string) {
  return { path: `artifacts/${name}.wav`, sha256: "a".repeat(64) };
}

/**
 * One cascade run. Every required gate PASSes unless the test names a gate to
 * fail; contamination is the run's own ineligibility, never a number.
 */
function cascadeRun(
  subject: SubjectRecord,
  gapMs: number | null,
  options: {
    runId: string;
    failGate?: string;
    events?: ScoreboardArtifact["events"];
  },
): ScoreboardArtifact {
  const voice = subject.agent.kind === "demo" ? subject.agent.voice : subject.agent.agentId;
  const artifact = buildSkeletonArtifact({
    voice,
    subject,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
    runId: options.runId,
    codeFingerprint: CLEAN_CODE,
    engine: {
      pipeline: "cascade",
      run: {
        runId: options.runId,
        variant: "cascade",
        startedAt: "2026-10-29T10:00:00.000Z",
        finishedAt: "2026-10-29T10:00:03.000Z",
      },
      captures: {
        reference: capture("reference"),
        platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
        delivered: capture("delivered"),
      },
      eligibility: { eligible: true },
    },
  });
  return {
    ...artifact,
    gates: PASS_GATES.map((gate) =>
      gate.name === options.failGate ? { ...gate, status: "FAIL" as const } : gate,
    ),
    latency:
      gapMs === null
        ? { replyGapP50Ms: { absent: "N/A — no reply measured" } }
        : { replyGapP50Ms: gapMs },
    ...(options.events !== undefined ? { events: options.events } : {}),
  };
}

/**
 * One round's attempts, interleaved the way the harness measures them: each
 * subject's two runs stay well apart in the array, so grouping is by subject
 * rather than by array adjacency.
 */
function measuredRound(
  label: string,
  gaps: [number, number, number, number] = [900, 950, 1000, 1050],
  options: { failGate?: string; contaminate?: 0 | 1 | 2 | 3; noGap?: 0 | 1 | 2 | 3 } = {},
): RoundInput {
  const attempts = [
    { subject: ANNA, gap: gaps[0], slot: 0 as const },
    { subject: LOLA, gap: gaps[1], slot: 1 as const },
    { subject: ANNA, gap: gaps[2], slot: 2 as const },
    { subject: LOLA, gap: gaps[3], slot: 3 as const },
  ];
  return {
    label,
    artifacts: attempts.map((attempt, index) => {
      const contaminated = options.contaminate === attempt.slot;
      return cascadeRun(attempt.subject, options.noGap === attempt.slot ? null : attempt.gap, {
        runId: `${label}-${attempt.subject.agent.kind === "demo" ? attempt.subject.agent.voice : "tenant"}-${index + 1}`,
        failGate: options.failGate,
        ...(contaminated
          ? { events: [{ type: "provider_fallback", leg: "llm", phase: "turn" }] }
          : {}),
      });
    }),
  };
}

function failingRound(label: string, gapMs = 1800): RoundInput {
  return measuredRound(label, [gapMs, gapMs, gapMs, gapMs]);
}

test("a one-sample scope is judged against the frozen tail, never its own median", () => {
  const one = judgeReplyGapScope("one run", [1600]);
  assert.equal(one.sampleCount, 1);
  assert.equal(one.smallSample, true);
  assert.equal(one.judgedAgainst, "p95");
  assert.equal(one.status, "PASS", "a single sample over the p50 bar is still a tail sample");
  assert.equal(one.p50BudgetMs, P50);
  assert.equal(one.p95BudgetMs, P95);
  assert.match(one.detail, /p95|tail/);

  const overTail = judgeReplyGapScope("one run", [P95 + 1]);
  assert.equal(overTail.status, "FAIL");
  assert.equal(overTail.judgedAgainst, "p95");

  const enough = judgeReplyGapScope("three runs", [1600, 1600, 1600]);
  assert.equal(enough.sampleCount, MIN_SAMPLES_FOR_P50);
  assert.equal(enough.smallSample, false);
  assert.equal(enough.judgedAgainst, "p50");
  assert.equal(enough.status, "FAIL", "a real median over the p50 bar is a p50 failure");
});

test("the small-sample rule and the reply-gap gate cannot disagree", () => {
  const gate = (gaps: number[]) =>
    replyGapGate(gaps.map((gapMs, index) => ({ beat: null, gapMs, turnIndex: index + 1 })));
  for (const gaps of [[1600], [1600, 1600], [1600, 1600, 1600], [900, 900, 900]]) {
    assert.equal(
      judgeReplyGapScope(`${gaps.length} runs`, gaps).status,
      gate(gaps).status,
      `scope size ${gaps.length} must follow the same small-sample rule`,
    );
  }
});

test("a measured round is two subjects with two consecutive clean runs each", () => {
  const verdict = evaluateKillCriterion({ rounds: [measuredRound("round-1")] });
  const round = verdict.rounds[0];
  assert.equal(round.disposition, "measured");
  assert.equal(round.measured, true);
  assert.equal(round.counted, true);
  assert.equal(round.replyGapPassed, true);
  assert.equal(round.subjects.length, 2);
  assert.equal(round.runs.length, 2 * 2);
  assert.equal(verdict.measuredCount, 1);
  assert.equal(verdict.status, "INCOMPLETE", "one measured round is not the three the criterion needs");
  assert.equal(verdict.automaticCutover, false);
});

test("a contaminated round is re-run and does not count toward the three", () => {
  const verdict = evaluateKillCriterion({
    rounds: [
      failingRound("round-1"),
      failingRound("round-2"),
      measuredRound("round-3", [1800, 1800, 1800, 1800], { contaminate: 3 }),
    ],
  });
  const contaminated = verdict.rounds[2];
  assert.equal(contaminated.disposition, "rerun");
  assert.equal(contaminated.counted, false);
  assert.equal(contaminated.measured, false);
  assert.match(contaminated.detail, /re-run/);
  assert.match(contaminated.detail, /provider fallback/);
  assert.equal(verdict.replyGapFailures.length, 2, "two counted failures, not three");
  assert.equal(verdict.killed, false);
  assert.equal(verdict.status, "INCOMPLETE");
});

test("clean runs separated by a contaminated one are not two consecutive clean runs", () => {
  const cleanPair = measuredRound("round-1");
  const separated: RoundInput = {
    label: "round-2",
    artifacts: [
      cleanPair.artifacts[0],
      cascadeRun(ANNA, 1800, {
        runId: "round-2-anna-2",
        events: [{ type: "provider_fallback", leg: "stt", phase: "turn" }],
      }),
      cleanPair.artifacts[2],
      cleanPair.artifacts[1],
      cleanPair.artifacts[3],
    ],
  };
  const verdict = evaluateKillCriterion({ rounds: [separated] });
  assert.equal(verdict.rounds[0].disposition, "rerun");
  assert.equal(verdict.rounds[0].counted, false);
  assert.match(verdict.rounds[0].detail, /two consecutive clean runs/);
});

test("three measured rounds failing the reply gap stop the automatic cutover", () => {
  const verdict = evaluateKillCriterion({
    rounds: [failingRound("round-1"), failingRound("round-2"), failingRound("round-3")],
  });
  assert.equal(verdict.killed, true);
  assert.equal(verdict.status, "KILLED");
  assert.equal(verdict.automaticCutover, false);
  assert.equal(verdict.blocksCutover, true);
  assert.equal(verdict.replyGapFailures.length, KILL_CRITERION_ROUNDS);
  assert.match(verdict.detail, /routing stays off/);
});

test("two measured reply-gap failures are not yet the kill criterion", () => {
  const verdict = evaluateKillCriterion({
    rounds: [failingRound("round-1"), failingRound("round-2")],
  });
  assert.equal(verdict.killed, false);
  assert.equal(verdict.status, "INCOMPLETE");
  assert.equal(verdict.automaticCutover, false);
});

test("a dated owner risk acceptance is representable and is never a pass", () => {
  const verdict = evaluateKillCriterion({
    rounds: [failingRound("round-1"), failingRound("round-2"), failingRound("round-3")],
    acceptance: {
      kind: "risk-acceptance",
      owner: "demo-owner",
      acceptedOn: "2026-10-30",
      decisionRecord: "docs/adr/0012-cascade-cutover-risk.md",
      evidence: ["round-1", "round-2", "round-3"],
    },
  });
  assert.equal(verdict.killed, true);
  assert.equal(verdict.status, "RISK-ACCEPTED");
  assert.notEqual(verdict.status, "PASS");
  assert.equal(verdict.automaticCutover, false, "acceptance is manual, never automatic");
  assert.equal(verdict.acceptance?.decisionRecord, "docs/adr/0012-cascade-cutover-risk.md");
  assert.match(verdict.detail, /risk-acceptance|risk acceptance/);
  assert.match(verdict.detail, /2026-10-30/);
});

test("an acceptance without a date, an owner or evidence is refused by name", () => {
  const rounds = [failingRound("round-1"), failingRound("round-2"), failingRound("round-3")];
  const base = {
    kind: "risk-acceptance" as const,
    owner: "demo-owner",
    acceptedOn: "2026-10-30",
    decisionRecord: "docs/adr/0012-cascade-cutover-risk.md",
    evidence: ["round-1"],
  };
  assert.throws(
    () => evaluateKillCriterion({ rounds, acceptance: { ...base, acceptedOn: "soon" } }),
    /acceptedOn/,
  );
  assert.throws(
    () => evaluateKillCriterion({ rounds, acceptance: { ...base, acceptedOn: "" } }),
    /acceptedOn/,
  );
  assert.throws(
    () => evaluateKillCriterion({ rounds, acceptance: { ...base, owner: "  " } }),
    /owner/,
  );
  assert.throws(
    () => evaluateKillCriterion({ rounds, acceptance: { ...base, evidence: [] } }),
    /evidence/,
  );
  assert.throws(
    () =>
      evaluateKillCriterion({
        rounds,
        acceptance: { ...base, decisionRecord: "" },
      }),
    /decisionRecord/,
  );
  assert.throws(
    () =>
      evaluateKillCriterion({
        rounds,
        acceptance: { ...base, evidence: ["round-1", ""] },
      }),
    /evidence/,
  );
});

test("a round that passes the reply gap but fails another gate blocks cutover without killing", () => {
  const verdict = evaluateKillCriterion({
    rounds: [
      measuredRound("round-1"),
      measuredRound("round-2"),
      measuredRound("round-3"),
      measuredRound("round-4", [900, 950, 1000, 1050], { failGate: "barge-in-cut" }),
    ],
  });
  assert.equal(verdict.killed, false);
  assert.equal(verdict.blocksCutover, true);
  assert.equal(verdict.automaticCutover, false);
  assert.equal(verdict.status, "BLOCKED");
  assert.equal(verdict.otherGateFailures.length, 1);
  assert.ok(verdict.otherGateFailures[0].otherGateFailures.includes("barge-in-cut"));
  assert.match(verdict.detail, /barge-in-cut/);
});

test("a run whose own reply-gap gate fails fails the round, even when the pooled median passes", () => {
  const base = measuredRound("round-1", [2000, 800, 800, 800]);
  const round: RoundInput = {
    label: base.label,
    artifacts: base.artifacts.map((artifact, index) =>
      index === 0
        ? {
            ...artifact,
            gates: artifact.gates.map((gate) =>
              gate.name === "reply-gap" ? { ...gate, status: "FAIL" as const } : gate,
            ),
          }
        : artifact,
    ),
  };
  const verdict = evaluateKillCriterion({ rounds: [round] });
  assert.equal(verdict.rounds[0].measured, true);
  assert.equal(verdict.rounds[0].replyGap?.status, "PASS", "the pooled median is inside the p50 bar");
  assert.equal(verdict.rounds[0].replyGapPassed, false, "the run's own gate is the stricter fact");
  assert.equal(verdict.replyGapFailures.length, 1);
  assert.match(verdict.rounds[0].detail, /own reply-gap gate FAIL/);
});

test("a round with no measured reply gap is not counted", () => {  const verdict = evaluateKillCriterion({
    rounds: [measuredRound("round-1", [900, 950, 1000, 1050], { noGap: 3 })],
  });
  assert.equal(verdict.rounds[0].disposition, "incomplete");
  assert.equal(verdict.rounds[0].counted, false);
  assert.match(verdict.rounds[0].detail, /no measured reply gap/);
});

test("a round needs two subjects, not one subject measured four times", () => {
  const oneSubject: RoundInput = {
    label: "round-1",
    artifacts: [
      cascadeRun(ANNA, 900, { runId: "anna-1" }),
      cascadeRun(ANNA, 950, { runId: "anna-2" }),
      cascadeRun(ANNA, 1000, { runId: "anna-3" }),
      cascadeRun(ANNA, 1050, { runId: "anna-4" }),
    ],
  };
  const verdict = evaluateKillCriterion({ rounds: [oneSubject] });
  assert.equal(verdict.rounds[0].disposition, "incomplete");
  assert.match(verdict.rounds[0].detail, /two subjects/);
});
