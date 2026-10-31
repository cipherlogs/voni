import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContract } from "../../contract";
import { loadCorpus } from "../../scenarios";
import { judgeProperty } from "../judge";
import type { EvaluatorContext, PropertyEvidence, PropertyEvaluator } from "../types";
import { loadEvaluatorModules, buildEvaluatorRegistry } from "../evaluators";
import turnTaking from "./turn-taking.evaluators";

/**
 * T1–T10 over one real-shaped call: a delivered WAV with known tones and
 * gaps, the synthetic microphone's take times, the browser marks and the
 * pipeline's turn ledger. A passing call and each violation are both proven,
 * so an evaluator that cannot see a failure cannot report green.
 */

const RATE = 24_000;
const T0 = 1_700_000_000_000;
const roots: string[] = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Span = { kind: "tone" | "silence"; ms: number; freq?: number };

function wav(spans: readonly Span[]): { file: string; durationMs: number } {
  const samples: number[] = [];
  for (const span of spans) {
    const count = Math.round((span.ms / 1000) * RATE);
    for (let index = 0; index < count; index += 1) {
      samples.push(
        span.kind === "silence"
          ? 0
          : Math.round(
              Math.sin((2 * Math.PI * (span.freq ?? 440) * index) / RATE) * 12_000,
            ),
      );
    }
  }
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, index) => bytes.writeInt16LE(value, 44 + index * 2));
  const root = mkdtempSync(join(tmpdir(), "dv19-turn-"));
  roots.push(root);
  const file = join(root, "delivered.wav");
  writeFileSync(file, bytes);
  return { file, durationMs: (samples.length / RATE) * 1000 };
}

type Take = { step: number; take: string; text: string; atMs: number; durationMs: number };

type CallSpec = {
  readonly spans: readonly Span[];
  readonly takes: readonly Take[];
  readonly turns: readonly { type: string; turn: string; atMs: number; [key: string]: unknown }[];
  readonly endedAtMs: number;
  readonly endReceivedAtMs?: number;
  readonly marks?: { firstAudibleAtMs: number };
};

/** One call's evidence bundle, on one wall clock. */
function bundle(spec: CallSpec): {
  evidence: EvaluatorContext["evidence"];
  facts: { takes: { id: string; text: string | null }[] };
} {
  const { file, durationMs } = wav(spec.spans);
  const startedAt = T0 - 500;
  const marks = {
    schemaVersion: 1,
    callId: "call-1",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(T0 + spec.endedAtMs).toISOString(),
    marks: [
      {
        name: "first_audible",
        at: new Date(T0).toISOString(),
        epochMs: T0,
        tMs: 500,
      },
      {
        name: "end_received",
        at: new Date(T0 + (spec.endReceivedAtMs ?? spec.endedAtMs)).toISOString(),
        epochMs: T0 + (spec.endReceivedAtMs ?? spec.endedAtMs),
        tMs: 500 + (spec.endReceivedAtMs ?? spec.endedAtMs),
      },
      {
        name: "teardown",
        at: new Date(T0 + spec.endedAtMs).toISOString(),
        epochMs: T0 + spec.endedAtMs,
        tMs: 500 + spec.endedAtMs,
      },
    ],
  };
  return {
    evidence: {
      ledger: {
        file: "/run/end.json",
        end: {
          type: "end",
          callId: "call-1",
          endedBy: "stop",
          metrics: {},
          cost: {},
        },
        endGap: null,
        turns: spec.turns,
        turnIds: [...new Set(spec.turns.map((row) => row.turn))],
        marks,
        marksGap: "",
      },
      trace: { file: "/run/trace.jsonl", rows: spec.turns, lineCount: spec.turns.length },
      wav: { file, sampleRate: RATE, channels: 1, bitsPerSample: 16, durationMs },
      browser: {
        file: "/run/call-marks.json",
        marks,
        captions: [],
        capture: { file, name: "delivered-call-1.wav", bytes: 1, sampleRate: RATE, seconds: 1 },
        syntheticMic: {
          method: "getUserMedia",
          installedAt: T0,
          installedBeforeAppCode: true,
          takesPlayed: spec.takes.map((take) => ({
            ...take,
            epochMs: T0 + take.atMs,
          })),
          sampleRate: RATE,
        },
      },
    },
    facts: {
      takes: spec.takes.map((take) => ({ id: take.take, text: take.text })),
    },
  };
}

function assertMs(actual: readonly number[] | undefined, expected: readonly number[]): void {
  assert.ok(actual !== undefined, "measured samples");
  assert.equal(actual.length, expected.length, JSON.stringify(actual));
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]!) <= 20,
      `sample ${index}: ${value} != ${expected[index]} (±20 ms)`,
    );
  });
}

function evaluator(id: string): PropertyEvaluator {
  const found = turnTaking.evaluators.find((entry) => entry.propertyId === id);
  assert.ok(found, `${id} has an evaluator`);
  return found;
}

async function evaluate(id: string, spec: CallSpec) {
  const { evidence, facts } = bundle(spec);
  const contract = await loadContract();
  const property = contract.properties.find((entry) => entry.id === id);
  assert.ok(property, `${id} is in the contract`);
  return evaluator(id).evaluate({
    property,
    scenario: "turn-taking-barge",
    repetition: 1,
    source: evidence.ledger,
    evidence,
    facts,
  });
}

/** Two caller turns, a greeting and two replies, no overlap. */
function cleanCall(): CallSpec {
  return {
    spans: [
      { kind: "tone", ms: 400 },
      { kind: "silence", ms: 600 },
      { kind: "tone", ms: 800 },
      { kind: "silence", ms: 1_200 },
      { kind: "tone", ms: 800 },
      { kind: "silence", ms: 700 },
    ],
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 500 },
      { step: 1, take: "ask", text: "What are your hours?", atMs: 2_000, durationMs: 700 },
    ],
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 500, chars: 20, wantsEnd: false },
      { type: "turn.reply_start", turn: "1:1", atMs: 550 },
      { type: "turn.first_audio", turn: "1:1", atMs: 1_000, seq: 0 },
      { type: "turn.user_final", turn: "2:2", atMs: 2_700, chars: 20, wantsEnd: false },
      { type: "turn.reply_start", turn: "2:2", atMs: 2_750 },
      { type: "turn.first_audio", turn: "2:2", atMs: 3_000, seq: 0 },
    ],
    endedAtMs: 4_500,
  };
}

test("T1 measures caller-take end to the first delivered response onset", async () => {
  const result = await evaluate("T1", cleanCall());
  assert.equal(result.kind, "measured");
  if (result.kind !== "measured") return;
  assertMs(result.samples, [500, 300]);
});

test("T2 measures the caller final to the reply's first audio row", async () => {
  const result = await evaluate("T2", cleanCall());
  assert.equal(result.kind, "measured");
  if (result.kind !== "measured") return;
  assertMs(result.samples, [500, 300]);
});

test("T3 measures the stop from the caller's barge onset and cites the cut", async () => {
  const spec = cleanCall();
  const result = await evaluate("T3", {
    ...spec,
    spans: [
      { kind: "tone", ms: 1_200 },
      { kind: "silence", ms: 800 },
      { kind: "tone", ms: 600 },
    ],
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 400 },
      { step: 1, take: "barge", text: "Sorry, wait, before you go on.", atMs: 800, durationMs: 600 },
    ],
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 400, wantsEnd: false },
      { type: "turn.reply_start", turn: "1:1", atMs: 450 },
      { type: "turn.first_audio", turn: "1:1", atMs: 500, seq: 0 },
      { type: "turn.cut", turn: "1:1", atMs: 900, reason: "barge_in" },
      { type: "turn.user_final", turn: "2:2", atMs: 1_500, wantsEnd: false },
      { type: "turn.reply_start", turn: "2:2", atMs: 1_600 },
      { type: "turn.first_audio", turn: "2:2", atMs: 2_000, seq: 0 },
    ],
    endedAtMs: 3_000,
  });
  assert.equal(result.kind, "measured");
  if (result.kind !== "measured") return;
  // The agent is sounding from 0 ms to 1,200 ms; the barge starts at 800 ms.
  assertMs(result.samples, [400]);
  assert.ok(result.citations?.includes("turn:1:1"), JSON.stringify(result.citations));
});

test("T4 counts a caller final beyond the authored real turns", async () => {
  const spec = cleanCall();
  const result = await evaluate("T4", {
    ...spec,
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 500 },
      { step: 1, take: "filler", text: "Mm-hmm.", atMs: 1_600, durationMs: 300 },
    ],
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 600, wantsEnd: false },
      { type: "turn.reply_start", turn: "1:1", atMs: 700 },
      { type: "turn.first_audio", turn: "1:1", atMs: 800, seq: 0 },
      { type: "turn.user_final", turn: "2:2", atMs: 1_950, wantsEnd: false },
      { type: "turn.reply_start", turn: "2:2", atMs: 2_050 },
      { type: "turn.first_audio", turn: "2:2", atMs: 2_200, seq: 0 },
    ],
  });
  assert.equal(result.kind, "measured");
  if (result.kind !== "measured") return;
  assert.deepEqual(result.samples, [1]);
  assert.ok(result.citations?.includes("turn:2:2"));
});

test("T5 times the resume after a filler and refuses a repeated tail", async () => {
  const spec = cleanCall();
  const clean = await evaluate("T5", {
    ...spec,
    spans: [
      { kind: "tone", ms: 800 },
      { kind: "silence", ms: 200 },
      { kind: "tone", ms: 700, freq: 700 },
    ],
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 400 },
      { step: 1, take: "filler", text: "Mm-hmm.", atMs: 750, durationMs: 200 },
    ],
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 500, wantsEnd: false },
      { type: "turn.reply_start", turn: "1:1", atMs: 550 },
      { type: "turn.first_audio", turn: "1:1", atMs: 600, seq: 0 },
      { type: "turn.cut", turn: "1:1", atMs: 950, reason: "barge_in" },
    ],
  });
  assert.equal(clean.kind, "measured");
  if (clean.kind !== "measured") return;
  // The filler ends at 950 ms; the resumed tone starts at 1,000 ms.
  assertMs(clean.samples, [50]);

  const repeated = await evaluate("T5", {
    ...spec,
    spans: [
      { kind: "tone", ms: 800 },
      { kind: "silence", ms: 200 },
      { kind: "tone", ms: 800 },
    ],
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 400 },
      { step: 1, take: "filler", text: "Mm-hmm.", atMs: 750, durationMs: 200 },
    ],
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 500, wantsEnd: false },
      { type: "turn.reply_start", turn: "1:1", atMs: 550 },
      { type: "turn.first_audio", turn: "1:1", atMs: 600, seq: 0 },
      { type: "turn.cut", turn: "1:1", atMs: 950, reason: "barge_in" },
    ],
  });
  assert.equal(repeated.kind, "unmeasured");
  if (repeated.kind !== "unmeasured") return;
  assert.match(repeated.reason, /repeat/);
});

test("T6 fails a reply that restarts from the top after a clause cut", async () => {
  const spec = cleanCall();
  const resumed = await evaluate("T6", {
    ...spec,
    spans: [
      { kind: "tone", ms: 900 },
      { kind: "silence", ms: 400 },
      { kind: "tone", ms: 700, freq: 900 },
    ],
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 400 },
      { step: 1, take: "barge", text: "Sorry, wait, before you go on.", atMs: 600, durationMs: 500 },
    ],
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 400, wantsEnd: false },
      { type: "turn.cut", turn: "1:1", atMs: 650, reason: "barge_in" },
      { type: "turn.first_audio", turn: "2:2", atMs: 1_400, seq: 0 },
    ],
  });
  assert.equal(resumed.kind, "measured");
  if (resumed.kind !== "measured") return;
  assert.deepEqual(resumed.samples, [0]);

  const restarted = await evaluate("T6", {
    ...spec,
    spans: [
      { kind: "tone", ms: 900 },
      { kind: "silence", ms: 400 },
      { kind: "tone", ms: 900 },
    ],
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 400 },
      { step: 1, take: "barge", text: "Sorry, wait, before you go on.", atMs: 600, durationMs: 500 },
    ],
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 400, wantsEnd: false },
      { type: "turn.cut", turn: "1:1", atMs: 650, reason: "barge_in" },
      { type: "turn.first_audio", turn: "2:2", atMs: 1_400, seq: 0 },
    ],
  });
  assert.equal(restarted.kind, "measured");
  if (restarted.kind !== "measured") return;
  assert.deepEqual(restarted.samples, [1]);
});

test("T7 counts doubled frames and a lost final, and names both", async () => {
  const spec = cleanCall();
  const doubled = await evaluate("T7", {
    ...spec,
    spans: [
      { kind: "tone", ms: 700 },
      { kind: "silence", ms: 80 },
      { kind: "tone", ms: 700 },
      { kind: "silence", ms: 400 },
    ],
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 400 },
      { step: 1, take: "barge", text: "Sorry, wait, before you go on.", atMs: 200, durationMs: 500 },
    ],
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 400, wantsEnd: false },
      { type: "turn.first_audio", turn: "1:1", atMs: 450, seq: 0 },
      { type: "turn.cut", turn: "1:1", atMs: 500, reason: "barge_in" },
    ],
  });
  assert.equal(doubled.kind, "measured");
  if (doubled.kind !== "measured") return;
  // 700 ms of repeated audio plus one final the caller spoke but the pipeline never wrote.
  assert.ok((doubled.samples?.[0] ?? 0) >= 16_000, JSON.stringify(doubled.samples));
  assert.match(doubled.detail ?? "", /doubled/);
  assert.match(doubled.detail ?? "", /lost final/);
});

test("T8 measures the longest uncovered pause and ignores a caller turn", async () => {
  const spec = cleanCall();
  const dead = await evaluate("T8", {
    ...spec,
    spans: [
      { kind: "tone", ms: 500 },
      { kind: "silence", ms: 1_100 },
      { kind: "tone", ms: 500 },
      { kind: "silence", ms: 400 },
    ],
    takes: [{ step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 300 }],
    turns: [{ type: "turn.user_final", turn: "1:1", atMs: 300, wantsEnd: false }],
  });
  assert.equal(dead.kind, "measured");
  if (dead.kind !== "measured") return;
  assertMs(dead.samples, [1_100]);

  const bridged = await evaluate("T8", {
    ...spec,
    spans: [
      { kind: "tone", ms: 500 },
      { kind: "silence", ms: 1_100 },
      { kind: "tone", ms: 500 },
      { kind: "silence", ms: 400 },
    ],
    takes: [
      { step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 300 },
      { step: 1, take: "ask", text: "What are your hours?", atMs: 600, durationMs: 400 },
    ],
    turns: [{ type: "turn.user_final", turn: "1:1", atMs: 1_000, wantsEnd: false }],
  });
  assert.equal(bridged.kind, "measured");
  if (bridged.kind !== "measured") return;
  assert.deepEqual(bridged.samples, [0]);
});

test("T9 reports a premature-cut ratio and refuses a missed end", async () => {
  const spec = cleanCall();
  const clean = await evaluate("T9", cleanCall());
  assert.equal(clean.kind, "measured");
  if (clean.kind !== "measured") return;
  assert.deepEqual(clean.samples, [0]);

  const missed = await evaluate("T9", {
    ...spec,
    spans: [
      { kind: "tone", ms: 200 },
      { kind: "silence", ms: 1_800 },
      { kind: "tone", ms: 500 },
    ],
    takes: [{ step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 0, durationMs: 500 }],
    turns: [{ type: "turn.user_final", turn: "1:1", atMs: 1_500, wantsEnd: false }],
  });
  assert.equal(missed.kind, "unmeasured");
  if (missed.kind !== "unmeasured") return;
  assert.match(missed.reason, /missed end/);
});

test("T10 counts a reply that starts while the caller is still speaking", async () => {
  const spec = cleanCall();
  const clean = await evaluate("T10", cleanCall());
  assert.equal(clean.kind, "measured");
  if (clean.kind !== "measured") return;
  assert.deepEqual(clean.samples, [0]);

  const overlap = await evaluate("T10", {
    ...spec,
    spans: [
      { kind: "tone", ms: 200 },
      { kind: "silence", ms: 800 },
      { kind: "tone", ms: 700 },
      { kind: "silence", ms: 500 },
    ],
    takes: [{ step: 0, take: "hello", text: "Hi, is this Voni?", atMs: 500, durationMs: 1_000 }],
    turns: [{ type: "turn.user_final", turn: "1:1", atMs: 1_500, wantsEnd: false }],
  });
  assert.equal(overlap.kind, "measured");
  if (overlap.kind !== "measured") return;
  assert.deepEqual(overlap.samples, [1]);
});

test("a call without browser marks fails closed instead of passing", async () => {
  const { evidence, facts } = bundle(cleanCall());
  const contract = await loadContract();
  const property = contract.properties.find((entry) => entry.id === "T1");
  assert.ok(property);
  const result = await evaluator("T1").evaluate({
    property,
    scenario: "turn-taking-barge",
    repetition: 1,
    source: evidence.ledger,
    evidence: { ...evidence, browser: undefined },
    facts,
  });
  assert.equal(result.kind, "unmeasured");
  if (result.kind !== "unmeasured") return;
  assert.match(result.reason, /missing-evidence|malformed-evidence/);
});

test("every T property is registered with the contract's own bar keys", async () => {
  const contract = await loadContract();
  const modules = await loadEvaluatorModules();
  const registry = buildEvaluatorRegistry(modules, contract);
  for (let index = 1; index <= 10; index += 1) {
    const id = `T${index}`;
    assert.ok(
      registry.some((entry) => entry.propertyId === id),
      `${id} has a registered evaluator`,
    );
  }
  const property = contract.properties.find((entry) => entry.id === "T3");
  assert.ok(property);
  const evidence: PropertyEvidence = {
    propertyId: "T3",
    bars: evaluator("T3").bars,
    measurements: [
      { propertyId: "T3", scenario: "turn-taking-barge", repetition: 1, outcome: "measured", samples: [120, 200, 260], citations: [], passed: undefined },
      { propertyId: "T3", scenario: "turn-taking-barge", repetition: 2, outcome: "measured", samples: [120, 200, 260], citations: [] },
      { propertyId: "T3", scenario: "turn-taking-barge", repetition: 3, outcome: "measured", samples: [120, 200, 260], citations: [] },
    ] as unknown as PropertyEvidence["measurements"],
  };
  const verdict = judgeProperty(property, evidence);
  assert.equal(verdict.status, "PASS", verdict.detail);
});

test("a scenario cites every T property it produces", async () => {
  const contract = await loadContract();
  const corpus = await loadCorpus({
    knownProperties: new Set(contract.properties.map((entry) => entry.id)),
  });
  const cited = new Set(
    corpus.scenarios
      .filter((scenario) => !scenario.heldOut)
      .flatMap((scenario) => [...scenario.expectedProperties]),
  );
  for (let index = 1; index <= 10; index += 1) {
    assert.ok(cited.has(`T${index}`), `no committed scenario cites T${index}`);
  }
});

test("the turn-taking module is discoverable by the directory loader", async () => {
  const modules = await loadEvaluatorModules();
  const found = modules.find((entry) => entry.module.family === "turn-taking");
  assert.ok(found, "turn-taking.evaluators.ts is discovered");
  assert.equal(found.module.evaluators.length, 10);
});
