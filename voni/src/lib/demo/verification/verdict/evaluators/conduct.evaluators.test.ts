import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContract } from "../../contract";
import { loadCorpus } from "../../scenarios";
import { judgeProperty } from "../judge";
import type { EvaluatorContext, PropertyEvaluator } from "../types";
import { buildEvaluatorRegistry, loadEvaluatorModules } from "../evaluators";
import conduct from "./conduct.evaluators";

/**
 * C1–C10 over one call: the persisted end message, the browser marks, the
 * delivered WAV's tail, the visitor's captions and an independent judge's
 * findings. A missing judge or anchor is a named refusal, never a pass.
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
  const root = mkdtempSync(join(tmpdir(), "dv19-conduct-"));
  roots.push(root);
  const file = join(root, "delivered.wav");
  writeFileSync(file, bytes);
  return { file, durationMs: (samples.length / RATE) * 1000 };
}

type CallSpec = {
  readonly spans: readonly Span[];
  readonly endedBy?: string;
  readonly turns?: readonly { type: string; turn: string; atMs: number; [key: string]: unknown }[];
  readonly teardownAtMs?: number;
  readonly endReceivedAtMs?: number;
  readonly captions?: readonly { role: "caller" | "agent"; text: string }[];
  readonly judge?: Record<string, unknown> | null;
};

function bundle(spec: CallSpec): EvaluatorContext["evidence"] {
  const { file, durationMs } = wav(spec.spans);
  const startedAt = T0 - 500;
  const endReceivedAt = spec.endReceivedAtMs ?? spec.teardownAtMs ?? 3_000;
  const marks = {
    schemaVersion: 1,
    callId: "call-1",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(T0 + endReceivedAt).toISOString(),
    marks: [
      { name: "first_audible", at: new Date(T0).toISOString(), epochMs: T0, tMs: 500 },
      {
        name: "end_received",
        at: new Date(T0 + endReceivedAt).toISOString(),
        epochMs: T0 + endReceivedAt,
        tMs: 500 + endReceivedAt,
      },
      {
        name: "teardown",
        at: new Date(T0 + (spec.teardownAtMs ?? 3_000)).toISOString(),
        epochMs: T0 + (spec.teardownAtMs ?? 3_000),
        tMs: 500 + (spec.teardownAtMs ?? 3_000),
      },
    ],
  };
  const turns = spec.turns ?? [];
  return {
    ledger: {
      file: "/run/end.json",
      end: {
        type: "end",
        callId: "call-1",
        endedBy: spec.endedBy ?? "stop",
        metrics: {},
        cost: {},
      },
      endGap: null,
      turns,
      turnIds: [...new Set(turns.map((row) => row.turn))],
      marks,
      marksGap: "",
    },
    trace: { file: "/run/trace.jsonl", rows: turns, lineCount: turns.length },
    wav: { file, sampleRate: RATE, channels: 1, bitsPerSample: 16, durationMs },
    browser: {
      file: "/run/call-marks.json",
      marks,
      captions: spec.captions ?? [],
      capture: { file, name: "delivered-call-1.wav", bytes: 1, sampleRate: RATE, seconds: 1 },
      syntheticMic: { method: "getUserMedia", takesPlayed: [], sampleRate: RATE },
    },
    ...(spec.judge === null || spec.judge === undefined ? {} : { judge: spec.judge }),
  };
}

function evaluator(id: string): PropertyEvaluator {
  const found = conduct.evaluators.find((entry) => entry.propertyId === id);
  assert.ok(found, `${id} has an evaluator`);
  return found;
}

async function evaluate(id: string, spec: CallSpec) {
  const contract = await loadContract();
  const property = contract.properties.find((entry) => entry.id === id);
  assert.ok(property, `${id} is in the contract`);
  const evidence = bundle(spec);
  return evaluator(id).evaluate({
    property,
    scenario: "conduct",
    repetition: 1,
    source: evidence[property.evidence as keyof typeof evidence],
    evidence,
    facts: { takes: [] },
  });
}

const HANGUP = { type: "turn.hangup", turn: "1:1", atMs: 900, reason: "caller_end" };

test("C1 passes a caller-requested end and fails an agent-only end", async () => {
  const callerEnd = await evaluate("C1", {
    spans: [{ kind: "tone", ms: 1_500 }],
    endedBy: "stop",
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 800, wantsEnd: true },
      HANGUP,
    ],
  });
  assert.equal(callerEnd.kind, "measured");
  if (callerEnd.kind !== "measured") return;
  assert.deepEqual(callerEnd.samples, [0]);

  const unilateral = await evaluate("C1", {
    spans: [{ kind: "tone", ms: 1_500 }],
    endedBy: "stop",
    turns: [
      { type: "turn.user_final", turn: "1:1", atMs: 800, wantsEnd: false },
      { type: "turn.tool_call", turn: "1:1", atMs: 850, name: "end_call" },
      { type: "turn.hangup", turn: "1:1", atMs: 900, reason: "end_call" },
    ],
  });
  assert.equal(unilateral.kind, "measured");
  if (unilateral.kind !== "measured") return;
  assert.deepEqual(unilateral.samples, [1]);

  const budget = await evaluate("C1", {
    spans: [{ kind: "tone", ms: 1_500 }],
    endedBy: "budget",
    turns: [],
  });
  assert.equal(budget.kind, "measured");
  if (budget.kind !== "measured") return;
  assert.deepEqual(budget.samples, [0]);
});

test("C2 measures how long a greeting-only call stayed open", async () => {
  const open = await evaluate("C2", {
    spans: [{ kind: "tone", ms: 1_500 }],
    teardownAtMs: 31_000,
    endReceivedAtMs: 31_000,
  });
  assert.equal(open.kind, "measured");
  if (open.kind !== "measured") return;
  assert.deepEqual(open.samples, [31]);

  const closed = await evaluate("C2", {
    spans: [{ kind: "tone", ms: 1_500 }],
    teardownAtMs: 5_000,
    endReceivedAtMs: 5_000,
    turns: [HANGUP],
  });
  assert.equal(closed.kind, "measured");
  if (closed.kind !== "measured") return;
  assert.deepEqual(closed.samples, [5]);
});

test("C3 counts clarification loops and invented meaning from the judge", async () => {
  const clean = await evaluate("C3", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: {
      findings: [
        {
          propertyId: "C3",
          passed: true,
          citations: ["judge:c3"],
          clarificationCount: 1,
          invented: [],
        },
      ],
    },
  });
  assert.equal(clean.kind, "measured");
  if (clean.kind !== "measured") return;
  assert.deepEqual(clean.samples, [0]);

  const looping = await evaluate("C3", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: {
      findings: [
        {
          propertyId: "C3",
          passed: false,
          citations: ["judge:c3"],
          clarificationCount: 2,
          invented: ["the moon appointment"],
        },
      ],
    },
  });
  assert.equal(looping.kind, "measured");
  if (looping.kind !== "measured") return;
  assert.deepEqual(looping.samples, [2]);
});

test("C4 counts a hang-up and more than one boundary", async () => {
  const clean = await evaluate("C4", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: { findings: [{ propertyId: "C4", passed: true, hangUps: 0, boundaries: 1 }] },
  });
  assert.equal(clean.kind, "measured");
  if (clean.kind !== "measured") return;
  assert.deepEqual(clean.samples, [0]);

  const hostile = await evaluate("C4", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: { findings: [{ propertyId: "C4", passed: false, hangUps: 0, boundaries: 2 }] },
  });
  assert.equal(hostile.kind, "measured");
  if (hostile.kind !== "measured") return;
  assert.deepEqual(hostile.samples, [1]);
});

test("C5 counts a verbatim repeated agent line from the visitor's captions", async () => {
  const clean = await evaluate("C5", {
    spans: [{ kind: "tone", ms: 1_000 }],
    captions: [
      { role: "caller", text: "Hi there." },
      { role: "agent", text: "We open at nine." },
      { role: "agent", text: "Anything else?" },
    ],
  });
  assert.equal(clean.kind, "measured");
  if (clean.kind !== "measured") return;
  assert.deepEqual(clean.samples, [0]);

  const repeated = await evaluate("C5", {
    spans: [{ kind: "tone", ms: 1_000 }],
    captions: [
      { role: "caller", text: "Hi there." },
      { role: "agent", text: "We open at nine." },
      { role: "agent", text: "We open at nine." },
    ],
  });
  assert.equal(repeated.kind, "measured");
  if (repeated.kind !== "measured") return;
  assert.deepEqual(repeated.samples, [1]);
});

test("C6 counts tool narration and a claim of undone work", async () => {
  const clean = await evaluate("C6", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: { findings: [{ propertyId: "C6", passed: true, toolNarrations: [], undoneClaims: [] }] },
  });
  assert.equal(clean.kind, "measured");
  if (clean.kind !== "measured") return;
  assert.deepEqual(clean.samples, [0]);

  const narrated = await evaluate("C6", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: {
      findings: [
        {
          propertyId: "C6",
          passed: false,
          toolNarrations: ["Calling the email tool now."],
          undoneClaims: ["I have sent it."],
        },
      ],
    },
  });
  assert.equal(narrated.kind, "measured");
  if (narrated.kind !== "measured") return;
  assert.deepEqual(narrated.samples, [2]);
});

test("C7 measures the drop after the last delivered sample", async () => {
  const clean = await evaluate("C7", {
    spans: [
      { kind: "tone", ms: 1_000 },
      { kind: "silence", ms: 200 },
    ],
    turns: [{ type: "turn.hangup", turn: "1:1", atMs: 900, reason: "caller_end" }],
  });
  assert.equal(clean.kind, "measured", clean.kind === "unmeasured" ? clean.reason : "");
  if (clean.kind !== "measured") return;
  assert.ok(Math.abs((clean.samples?.[0] ?? 0) - 200) <= 20, JSON.stringify(clean.samples));

  const dragged = await evaluate("C7", {
    spans: [
      { kind: "tone", ms: 1_000 },
      { kind: "silence", ms: 900 },
    ],
    turns: [{ type: "turn.hangup", turn: "1:1", atMs: 900, reason: "caller_end" }],
  });
  assert.equal(dragged.kind, "measured");
  if (dragged.kind !== "measured") return;
  assert.ok((dragged.samples?.[0] ?? 0) >= 880, JSON.stringify(dragged.samples));
});

test("C8 finds a voiced segment that starts after the end receipt", async () => {
  const clean = await evaluate("C8", {
    spans: [
      { kind: "tone", ms: 1_000 },
      { kind: "silence", ms: 500 },
    ],
    endReceivedAtMs: 1_200,
    teardownAtMs: 1_600,
  });
  assert.equal(clean.kind, "measured", clean.kind === "unmeasured" ? clean.reason : "");
  if (clean.kind !== "measured") return;
  assert.deepEqual(clean.samples, [0]);

  const late = await evaluate("C8", {
    spans: [
      { kind: "tone", ms: 1_000 },
      { kind: "silence", ms: 500 },
      { kind: "tone", ms: 500 },
    ],
    endReceivedAtMs: 1_200,
    teardownAtMs: 2_100,
  });
  assert.equal(late.kind, "measured");
  if (late.kind !== "measured") return;
  assert.deepEqual(late.samples, [1]);
});

test("C9 and C10 are categorical judge verdicts, never self-assessments", async () => {
  const honest = await evaluate("C9", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: {
      findings: [{ propertyId: "C9", passed: true, honest: true, brief: true }],
    },
  });
  assert.equal(honest.kind, "measured");
  if (honest.kind !== "measured") return;
  assert.equal(honest.passed, true);

  const evasive = await evaluate("C9", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: {
      findings: [{ propertyId: "C9", passed: false, honest: false, brief: true }],
    },
  });
  assert.equal(evasive.kind, "measured");
  if (evasive.kind !== "measured") return;
  assert.equal(evasive.passed, false);

  const handoff = await evaluate("C10", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: {
      findings: [{ propertyId: "C10", passed: true, handoffRequested: true, ignored: false }],
    },
  });
  assert.equal(handoff.kind, "measured");
  if (handoff.kind !== "measured") return;
  assert.equal(handoff.passed, true);

  const ignored = await evaluate("C10", {
    spans: [{ kind: "tone", ms: 1_000 }],
    judge: {
      findings: [{ propertyId: "C10", passed: false, handoffRequested: true, ignored: true }],
    },
  });
  assert.equal(ignored.kind, "measured");
  if (ignored.kind !== "measured") return;
  assert.equal(ignored.passed, false);
});

test("a missing judge or caption record is unmeasured, never a pass", async () => {
  for (const id of ["C3", "C4", "C6", "C9", "C10"]) {
    const result = await evaluate(id, {
      spans: [{ kind: "tone", ms: 1_000 }],
      judge: null,
    });
    assert.equal(result.kind, "unmeasured", id);
  }
  const captions = await evaluate("C5", { spans: [{ kind: "tone", ms: 1_000 }], captions: [] });
  assert.equal(captions.kind, "unmeasured");
});

test("every C property is registered and cited by a committed scenario", async () => {
  const contract = await loadContract();
  const registry = buildEvaluatorRegistry(await loadEvaluatorModules(), contract);
  const corpus = await loadCorpus({
    knownProperties: new Set(contract.properties.map((entry) => entry.id)),
  });
  const cited = new Set(
    corpus.scenarios
      .filter((scenario) => !scenario.heldOut)
      .flatMap((scenario) => [...scenario.expectedProperties]),
  );
  for (let index = 1; index <= 10; index += 1) {
    const id = `C${index}`;
    assert.ok(registry.some((entry) => entry.propertyId === id), `${id} has an evaluator`);
    assert.ok(cited.has(id), `no committed scenario cites ${id}`);
  }
  const property = contract.properties.find((entry) => entry.id === "C1");
  assert.ok(property);
  const verdict = judgeProperty(property, {
    propertyId: "C1",
    bars: evaluator("C1").bars,
    measurements: [1, 2, 3].map((repetition) => ({
      propertyId: "C1",
      scenario: "golden-flow-substantive",
      repetition,
      outcome: "measured" as const,
      samples: [0],
      citations: [],
    })),
  });
  assert.equal(verdict.status, "PASS", verdict.detail);
});
