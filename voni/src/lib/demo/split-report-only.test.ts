/**
 * Contract guard for demo-latency ticket 05: the per-turn latency split is
 * report-only evidence and can never move the Reply gap gate.
 *
 * The same run is built twice — once with the artifact's `runnerEvidence`
 * carrying the split, once without it — and the gate rows, reply-gap medians,
 * tails and sample counts must be identical. The playout pre-roll may appear
 * only in `perceivedMs`, never in a gate input; the frozen budget table stays
 * byte-identical; and a structural assertion reads the reply-gap gate (and the
 * reply-gap sample assembly) source so wiring the split into either fails
 * before it can change a verdict.
 *
 * Fixtures are crafted Call trace rows plus client receipt marks with a known
 * 1000ms clock offset, so expected durations are worked subtractions (the
 * prior art of `runner-evidence.test.ts` and `latency-split.test.ts`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PLAYOUT_PREROLL_MS } from "./playout-preroll";
import { buildRunnerEvidence, type RunnerEvidence } from "./runner-evidence";
import { checkBudgetFreeze, budgetValues, SCOREBOARD_BUDGETS } from "./scoreboard-budgets";
import {
  buildSkeletonArtifact,
  DEFAULT_GATE_VOICE,
  GATE_PRIORITY,
  MEASURED_EVIDENCE_KINDS,
  parseTraceGaps,
  replyGapGate,
  REPLY_GAP_P50_BUDGET_MS,
  REPLY_GAP_P95_BUDGET_MS,
  type ReplyGapSample,
} from "./scoreboard";
import type { EvalEvent } from "./eval-events";

const SUMMARY = `EVAL SUMMARY ${JSON.stringify({
  scenario: "suite",
  runs: 1,
  failures: 0,
  scenarios: [
    { name: "stop-over", passed: 1, runs: 1 },
    { name: "silence-check-in", passed: 1, runs: 1 },
  ],
  traceSessions: ["sess_split"],
  playout: [
    { scenario: "stop-over", run: 1, wallClockMs: 27_213 },
    { scenario: "silence-check-in", run: 1, wallClockMs: 31_768 },
  ],
  audioChunks: 900,
  live: true,
  transport: "stored",
  agentId: "agent_d66c02a12f904b73a940a42032dbd36d",
  agentFingerprint: "fingerprint-abc",
  llmModel: "google/gemini-2.5-flash",
})}`;

/**
 * Three ordinary caller turns. The trace prints the gate's own `gap Nms`
 * (800 / 1200 / 1400), so the split's `endpointingMs + generationMs` must
 * reconcile with each row and never with a pre-roll-inflated number.
 */
const TRACE = [
  "sess_split  agent=agent_d66c02a12f904b73a940a42032dbd36d  12.0s  end=client_end",
  '0.50s  HEARD   "Hi."  (0.50s–1.00s)',
  '1.80s  VONI    "Hello."  (user_speech ttfa 300ms gap 800ms)',
  '3.50s  HEARD   "Question one."  (3.50s–4.00s)',
  '5.20s  VONI    "Answer one."  (user_speech ttfa 300ms gap 1200ms)',
  '7.00s  HEARD   "Question two."  (7.00s–7.50s)',
  '8.90s  VONI    "Answer two."  (user_speech ttfa 300ms gap 1400ms)',
];

/** Client receipts, exactly 1000ms behind the trace clock. */
const MARKS: EvalEvent[] = [
  { atMs: 600, type: "turn.user_final", sessionId: "sess_split", turnId: "turn-1" },
  { atMs: 800, type: "turn.reply_start", sessionId: "sess_split", turnId: "turn-1", replyId: "reply_1" },
  { atMs: 1_100, type: "reply.first_audio", sessionId: "sess_split", turnId: "turn-1", replyId: "reply_1", anchor: true },
  { atMs: 3_600, type: "turn.user_final", sessionId: "sess_split", turnId: "turn-2" },
  { atMs: 4_200, type: "turn.reply_start", sessionId: "sess_split", turnId: "turn-2", replyId: "reply_2" },
  { atMs: 4_500, type: "reply.first_audio", sessionId: "sess_split", turnId: "turn-2", replyId: "reply_2" },
  { atMs: 7_000, type: "turn.user_final", sessionId: "sess_split", turnId: "turn-3" },
  { atMs: 7_900, type: "turn.reply_start", sessionId: "sess_split", turnId: "turn-3", replyId: "reply_3" },
  { atMs: 8_200, type: "reply.first_audio", sessionId: "sess_split", turnId: "turn-3", replyId: "reply_3" },
];

function evidenceFor(marks: EvalEvent[] | undefined): RunnerEvidence {
  const evidence = buildRunnerEvidence({
    runnerStdout: SUMMARY,
    excerpts: [{ sessionId: "sess_split", excerpt: TRACE }],
    ...(marks ? { marks } : {}),
  });
  assert.ok(evidence, "the run produced runner evidence");
  return evidence;
}

const TRACE_GAPS = parseTraceGaps(TRACE);

/** One artifact input; only the evidence differs between the two builds. */
function artifactFor(evidence: RunnerEvidence | null) {
  return buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: SUMMARY,
    exitCode: 0,
    durationMs: 1_000,
    runs: 1,
    dryRun: true,
    runId: "run-split-guard",
    traceGaps: TRACE_GAPS,
    traceSessionId: "sess_split",
    traceExcerpt: TRACE,
    runnerEvidence: evidence,
  });
}

const withSplit = evidenceFor(MARKS);
const withoutSplit = evidenceFor(undefined);

function splits(evidence: RunnerEvidence) {
  const turns = evidence.sessions.flatMap((session) => session.turns);
  const latency = turns.flatMap((turn) => (turn.latency ? [{ turn, latency: turn.latency }] : []));
  assert.ok(latency.length > 0, "the marked run carries splits to compare");
  return latency;
}

test("the same run with and without the split has identical gates, medians, tails and counts", () => {
  const marked = artifactFor(withSplit);
  const plain = artifactFor(withoutSplit);

  assert.ok(plain.replyGap.samples > 0, "the run has reply-gap samples to compare");
  assert.deepEqual(marked.gates, plain.gates);
  assert.deepEqual(marked.subScores, plain.subScores);
  assert.deepEqual(marked.replyGap, plain.replyGap);
  assert.deepEqual(marked.beats, plain.beats);

  // The frozen numbers, not a re-derivation: 800/1200/1400 → nearest-rank
  // p50 1200, p95 1400, n=3.
  assert.deepEqual(marked.replyGap, { p50Ms: 1_200, p95Ms: 1_400, samples: 3 });
  const reply = marked.gates.find((gate) => gate.name === "reply-gap");
  assert.ok(reply);
  assert.equal(reply.status, "PASS");
  assert.match(reply.detail, /p50 1200ms \/ p95 1400ms/);
});

test("the pre-roll appears only in perceivedMs, never in a gate input", () => {
  assert.equal(PLAYOUT_PREROLL_MS, 500, "the worklet's fixed pre-roll is quoted, not tuned");

  for (const { turn, latency } of splits(withSplit)) {
    assert.equal(
      latency.perceivedMs,
      latency.endpointingMs + latency.generationMs + latency.deliveryMs + PLAYOUT_PREROLL_MS,
    );
    // The split reconciles with the gate's own Call-trace gap; the pre-roll is
    // not part of endpointing, generation or delivery.
    assert.equal(latency.endpointingMs + latency.generationMs, turn.gapMs);
    assert.equal(latency.deliveryMs, 300, "delivery stays the measured first-audio wait");
  }

  // Dropping the pre-roll, or inflating the perceived number, moves nothing:
  // both artifacts still report the same trace gaps.
  const missingPreroll = structuredClone(withSplit);
  const absurd = structuredClone(withSplit);
  for (const session of missingPreroll.sessions) {
    for (const turn of session.turns) {
      if (!turn.latency) continue;
      turn.latency.perceivedMs =
        turn.latency.endpointingMs + turn.latency.generationMs + turn.latency.deliveryMs;
    }
  }
  for (const session of absurd.sessions) {
    for (const turn of session.turns) {
      if (!turn.latency) continue;
      turn.latency.perceivedMs = 1_000_000_000;
      turn.latency.endpointingMs = -1_000_000;
      turn.latency.generationMs = 1_000_000_000;
      turn.latency.deliveryMs = 1_000_000_000;
      turn.latency.band = "post-cut";
    }
  }

  const baseline = artifactFor(withoutSplit);
  for (const evidence of [missingPreroll, absurd]) {
    const artifact = artifactFor(evidence);
    assert.deepEqual(artifact.gates, baseline.gates);
    assert.deepEqual(artifact.replyGap, baseline.replyGap);
    assert.deepEqual(artifact.beats, baseline.beats);
  }
});

test("gate inputs are built from Call trace gaps only, so a split is never a sample", () => {
  // Reply-gap samples come from `traceGaps` alone: a split-bearing evidence
  // object with no trace gaps cannot manufacture a sample.
  const noGaps = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: SUMMARY,
    exitCode: 0,
    durationMs: 1_000,
    runs: 1,
    dryRun: true,
    runId: "run-split-guard",
    runnerEvidence: withSplit,
  });
  assert.equal(noGaps.replyGap.samples, 0);
  assert.equal(noGaps.gates.find((gate) => gate.name === "reply-gap")?.status, "INFO");

  // The gate itself ignores any latency-shaped property a caller might add.
  const plainSamples: ReplyGapSample[] = [
    { beat: null, gapMs: 900, turnIndex: 1 },
    { beat: null, gapMs: 1_800, turnIndex: 2 },
  ];
  const poisoned = plainSamples.map(
    (sample) =>
      ({
        ...sample,
        perceivedMs: 1_000_000,
        endpointingMs: -1,
        generationMs: 1_000_000,
        deliveryMs: 1_000_000,
        latency: { perceivedMs: 1_000_000 },
      }) as ReplyGapSample,
  );
  assert.deepEqual(replyGapGate(poisoned, "sess_split"), replyGapGate(plainSamples, "sess_split"));
});

test("the budget freeze guard and its threshold table stay byte-identical", () => {
  const record = JSON.parse(
    readFileSync(new URL("./scoreboard-budgets.json", import.meta.url), "utf8"),
  ) as { version: number; budgets: Record<string, number> };

  assert.deepEqual(checkBudgetFreeze(budgetValues(SCOREBOARD_BUDGETS), record.budgets), []);
  assert.deepEqual(budgetValues(SCOREBOARD_BUDGETS), record.budgets);
  assert.equal(REPLY_GAP_P50_BUDGET_MS, 1_500);
  assert.equal(REPLY_GAP_P95_BUDGET_MS, 2_500);

  // A threshold edit is a spec change. Pin the exact bytes of both files so
  // the split cannot ride in with a re-tuned bar.
  const sha256 = (url: URL) => createHash("sha256").update(readFileSync(url)).digest("hex");
  assert.equal(
    sha256(new URL("./scoreboard-budgets.ts", import.meta.url)),
    "dd1aad93e7ffbf9aabf93a28016fdba7e9a679f67a1b8eed15326089bd74fa12",
    "scoreboard-budgets.ts is byte-identical",
  );
  assert.equal(
    sha256(new URL("./scoreboard-budgets.json", import.meta.url)),
    "4bb0f75419ebfba16716db6a6508cb791ebb0e8bc7ad272cbeabda1da1654bde",
    "scoreboard-budgets.json is byte-identical",
  );
});

test("no gate or sub-score exists for latency attribution", () => {
  const artifact = artifactFor(withSplit);
  assert.deepEqual(artifact.gates.map((gate) => gate.name), [...GATE_PRIORITY]);
  assert.deepEqual(
    artifact.subScores.map((subScore) => subScore.name),
    ["responsiveness", "barge-in", "overheard", "naturalness", "voice"],
  );
  for (const name of [...GATE_PRIORITY, ...artifact.subScores.map((row) => row.name)]) {
    assert.doesNotMatch(name, /latency|split|attribution|perceived/i);
  }
  // The split is evidence, never a measurement source a marks-only run can
  // claim (gotcha: `MEASURED_EVIDENCE_KINDS` decides what counts as measured).
  assert.ok(!MEASURED_EVIDENCE_KINDS.some((kind) => /latency|split/i.test(kind)));
});

test("the reply-gap gate and sample selection source never mention the split", () => {
  const source = readFileSync(new URL("./scoreboard.ts", import.meta.url), "utf8");

  const gateStart = source.indexOf("export function replyGapGate(");
  const gateEnd = source.indexOf("// ── Gate: end-of-turn", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, "the reply-gap gate section is findable");
  const gateSection = source.slice(gateStart, gateEnd);
  assert.ok(gateSection.length > 500, "the section under test is the real implementation");
  assert.doesNotMatch(gateSection, /latency|endpointingMs|generationMs|deliveryMs|perceivedMs/i);

  // Sample selection is where a leak would most plausibly land (a gate sample
  // built from `turn.latency`); it must read gaps only.
  const assemblyStart = source.indexOf("const samples: ReplyGapSample[] = [];");
  const assemblyEnd = source.indexOf("const traceUnverified =", assemblyStart);
  assert.ok(assemblyStart >= 0 && assemblyEnd > assemblyStart, "sample assembly is findable");
  const assembly = source.slice(assemblyStart, assemblyEnd);
  assert.ok(assembly.length > 500, "the assembly under test is the real implementation");
  assert.doesNotMatch(assembly, /latency|endpointingMs|generationMs|deliveryMs|perceivedMs/i);
});
