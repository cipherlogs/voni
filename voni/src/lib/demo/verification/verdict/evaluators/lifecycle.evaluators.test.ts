import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDefectCards, type CallEvidence } from "../../cards";
import { loadContract, type Contract } from "../../contract";
import type { ScenarioFacts } from "../../scenarios";
import { judgeProperty } from "../judge";
import { evaluateScenarios } from "../evaluators";
import type { EvidenceBundle, RunVerdict } from "../types";
import conduct from "./conduct.evaluators";
import lifecycle from "./lifecycle.evaluators";

/**
 * Ticket 18's red proofs and the L1–L11 / C1–C2 seams.
 *
 * The two reported bugs are fixtures first:
 *
 * 1. The client paints "connected" before the pipeline admits the call and
 *    before the first audible sample.
 * 2. A greeting-only call ends, with a goodbye cut by teardown.
 *
 * Each fixture is judged by the production evaluators and turned into a defect
 * card through the production card builder. The fixed fixture is judged by the
 * same evaluators, so a verdict flips without a harness change.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../..");
const CALL_ID = "call-18";
const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const SAMPLE_RATE = 16_000;

let contractPromise: Promise<Contract> | null = null;
const contract = () => {
  contractPromise ??= loadContract();
  return contractPromise;
};

type Segment = { readonly kind: "speech" | "silence"; readonly ms: number };

function writeWav(path: string, segments: readonly Segment[], amplitude = 0.25): string {
  const samples = segments.flatMap((segment) => {
    const count = Math.round((segment.ms / 1000) * SAMPLE_RATE);
    return Array.from({ length: count }, (_, index) =>
      segment.kind === "speech"
        ? Math.round(Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE) * amplitude * 32767)
        : 0,
    );
  });
  const dataBytes = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function wavDurationMs(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + segment.ms, 0);
}

function mark(name: string, tMs: number, detail?: Record<string, unknown>) {
  return {
    name,
    at: new Date(T0 + tMs).toISOString(),
    epochMs: T0 + tMs,
    tMs,
    ...(detail ? { detail } : {}),
  } as never;
}

function marksOf(entries: readonly ReturnType<typeof mark>[], endedAtMs: number) {
  return {
    schemaVersion: 1 as const,
    callId: CALL_ID,
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + endedAtMs).toISOString(),
    marks: entries,
  };
}

function endDocument(input: {
  endedBy: string;
  turns: number;
  greeting?: Record<string, unknown>;
  goodbye?: Record<string, unknown>;
  error?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: "end",
    callId: CALL_ID,
    metrics: { marks: {}, gaps_ms: {}, counts: {} },
    providers: {},
    cost: {},
    eligibility: { disposition: "cascade" },
    turns: input.turns,
    endedBy: input.endedBy,
    drain: { ok: true },
    bounds: [],
    ...(input.greeting === undefined ? {} : { greeting: input.greeting }),
    ...(input.goodbye === undefined ? {} : { goodbye: input.goodbye }),
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}

function bundle(input: {
  readonly marks: ReturnType<typeof marksOf>;
  readonly end: Record<string, unknown>;
  readonly traceRows: readonly Record<string, unknown>[];
  readonly wavPath: string;
  readonly durationMs: number;
}): EvidenceBundle {
  const turns = input.traceRows.filter(
    (row) => typeof row.turn === "string" && row.turn.trim() !== "",
  );
  return {
    ledger: {
      file: join(REPO_ROOT, "unused-end.json"),
      end: input.end,
      endGap: null,
      turns,
      turnIds: [...new Set(turns.map((row) => String(row.turn)))],
      marks: input.marks,
      marksGap: "",
    },
    trace: {
      file: join(REPO_ROOT, "unused-trace.jsonl"),
      rows: input.traceRows,
      lineCount: input.traceRows.length,
    },
    wav: {
      file: input.wavPath,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      frames: Math.round((input.durationMs / 1000) * SAMPLE_RATE),
      durationMs: input.durationMs,
      bytes: 44 + Math.round((input.durationMs / 1000) * SAMPLE_RATE) * 2,
    },
    tool: { calls: [], results: [] },
    browser: {
      file: join(REPO_ROOT, "unused-marks.json"),
      marks: input.marks,
      capture: {
        file: input.wavPath,
        name: `delivered-${CALL_ID}.wav`,
        bytes: 44,
        sampleRate: SAMPLE_RATE,
        seconds: input.durationMs / 1000,
      },
      syntheticMic: {
        method: "getUserMedia",
        installedAt: T0 - 1,
        installedBeforeAppCode: true,
        takesPlayed: [],
        sampleRate: SAMPLE_RATE,
      },
    },
  };
}

const GREETING_ONLY_FACTS: ScenarioFacts = {
  takes: [{ id: "hello", text: "Hi, is this Voni?" }],
};

async function judged(
  propertyId: string,
  evidence: EvidenceBundle,
  scenario: string,
  facts: ScenarioFacts | undefined = undefined,
): Promise<{
  property: Contract["properties"][number];
  verdict: ReturnType<typeof judgeProperty>;
  measurement: string;
}> {
  const loaded = await contract();
  const property = loaded.properties.find((entry) => entry.id === propertyId);
  assert.ok(property, `the contract has no ${propertyId}`);
  const all = [...lifecycle.evaluators, ...conduct.evaluators];
  const measured = await evaluateScenarios({
    contract: loaded,
    evaluators: all,
    attempts: [1, 2, 3].map((repetition) => ({
      scenario,
      repetition,
      locale: "en" as const,
      evidence,
      ...(facts === undefined ? {} : { facts }),
    })),
  });
  const found = measured.find((entry) => entry.propertyId === propertyId);
  assert.ok(found, `no evidence for ${propertyId}`);
  return {
    property,
    verdict: judgeProperty(property, found),
    measurement: found.measurements.map((entry) => entry.detail ?? entry.reason ?? "").join("; "),
  };
}

function runVerdict(properties: RunVerdict["properties"]): RunVerdict {
  return {
    runId: "run-18",
    verdict: "not-demo-ready",
    certifiable: false,
    eligible: true,
    eligibility: { eligible: true, reasons: [], callCount: 1 },
    properties,
    failedPropertyIds: properties
      .filter((property) => property.status === "FAIL")
      .map((property) => property.propertyId),
    unknownPropertyIds: [],
    failures: [],
    sampleCount: 1,
    citations: [],
    detail: "test",
  };
}

function callEvidence(scenario: string, wav: string, evidenceFiles: readonly string[]): CallEvidence {
  return {
    callId: CALL_ID,
    scenario,
    locale: "en",
    target: "local",
    turns: [],
    deliveredWav: wav,
    excerpts: [{ media: "delivered-wav", file: wav, startMs: 0, endMs: 500 }],
    evidenceFiles,
  };
}

/** Bug 1: connected paints at 350 ms, admission at 1250 ms, audio at 1600 ms. */
function connectedBeforeAdmission(): {
  evidence: EvidenceBundle;
  wav: string;
  trace: string;
  end: string;
  marks: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dv18-bug-a-"));
  const segments: Segment[] = [
    { kind: "silence", ms: 150 },
    { kind: "speech", ms: 1800 },
    { kind: "silence", ms: 1000 },
    { kind: "speech", ms: 1200 },
    { kind: "silence", ms: 400 },
  ];
  const wav = writeWav(join(root, "delivered.wav"), segments);
  const trace = join(root, "trace.jsonl");
  const traceRows: Record<string, unknown>[] = [
    { type: "greeting.start", callId: CALL_ID, atMs: 1300 },
    { type: "greeting.first_audio", callId: CALL_ID, atMs: 1600 },
    { type: "greeting.done", callId: CALL_ID, atMs: 2600 },
    { type: "turn.reply_start", callId: CALL_ID, turn: "1:reply", atMs: 2900 },
    { type: "turn.first_audio", callId: CALL_ID, turn: "1:reply", atMs: 3000 },
    { type: "turn.hangup", callId: CALL_ID, turn: "1:reply", atMs: 6000, reason: "caller_end" },
  ];
  writeFileSync(
    trace,
    traceRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
  const marks = marksOf(
    [
      mark("start_requested", 0),
      mark("mint_done", 120),
      mark("socket_open", 200),
      mark("microphone_acquired", 260),
      mark("config_sent", 300),
      mark("connected_painted", 350),
      mark("ringback_start", 0),
      mark("ringback_stop", 350),
      mark("talk_clock_start", 360),
      mark("admitted", 1250),
      mark("first_audible", 1600),
      mark("chime", 1610),
      mark("turn", 3000, { role: "user", index: 0 }),
      mark("end_received", 6000, { turns: 1 }),
      mark("delivered_capture", 6040, { name: `delivered-${CALL_ID}.wav`, complete: true }),
      mark("teardown", 6050),
    ],
    6100,
  );
  const end = endDocument({
    endedBy: "stop",
    turns: 1,
    greeting: { spoken: true, frames: 12, audioBytes: 57_600, sampleRate: SAMPLE_RATE, chime_fired: true },
  });
  const endPath = join(root, "end.json");
  writeFileSync(endPath, `${JSON.stringify(end, null, 2)}\n`, "utf8");
  const marksPath = join(root, "call-marks.json");
  writeFileSync(marksPath, `${JSON.stringify(marks, null, 2)}\n`, "utf8");
  return {
    evidence: bundle({
      marks,
      end,
      traceRows,
      wavPath: wav,
      durationMs: wavDurationMs(segments),
    }),
    wav,
    trace,
    end: endPath,
    marks: marksPath,
  };
}

/**
 * Bug 2: a greeting-only call ends at 8 s with an `end_call`, and its goodbye
 * is cut after 400 ms of a 1200 ms line. The call never stays open for 30 s.
 */
function greetingOnlyEnds(): {
  evidence: EvidenceBundle;
  wav: string;
  trace: string;
  end: string;
  marks: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dv18-bug-b-"));
  const segments: Segment[] = [
    { kind: "silence", ms: 100 },
    { kind: "speech", ms: 2500 },
    { kind: "silence", ms: 4000 },
    { kind: "speech", ms: 400 },
  ];
  const wav = writeWav(join(root, "delivered.wav"), segments);
  const trace = join(root, "trace.jsonl");
  const traceRows: Record<string, unknown>[] = [
    { type: "greeting.start", callId: CALL_ID, atMs: 800 },
    { type: "greeting.first_audio", callId: CALL_ID, atMs: 900 },
    { type: "greeting.done", callId: CALL_ID, atMs: 3400 },
    { type: "turn.goodbye", callId: CALL_ID, turn: "1:reply", atMs: 7950, reason: "end_call" },
    { type: "turn.hangup", callId: CALL_ID, turn: "1:reply", atMs: 8000, reason: "end_call" },
  ];
  writeFileSync(
    trace,
    traceRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
  const marks = marksOf(
    [
      mark("start_requested", 0),
      mark("mint_done", 100),
      mark("socket_open", 150),
      mark("microphone_acquired", 200),
      mark("config_sent", 210),
      mark("connected_painted", 250),
      mark("ringback_start", 0),
      mark("ringback_stop", 250),
      mark("talk_clock_start", 260),
      mark("admitted", 500),
      mark("first_audible", 800),
      mark("chime", 810),
      mark("end_call_received", 7950),
      mark("end_received", 8000, { turns: 0 }),
      mark("delivered_capture", 7990, { name: `delivered-${CALL_ID}.wav`, complete: true }),
      mark("teardown", 8010),
    ],
    8050,
  );
  const end = endDocument({
    endedBy: "stop",
    turns: 0,
    greeting: { spoken: true, frames: 10, audioBytes: 80_000, sampleRate: SAMPLE_RATE, chime_fired: true },
    goodbye: {
      spoken: true,
      reason: "spoken after the second failure",
      text: "Sorry, I have to end the call here. Goodbye.",
      frames: 6,
      audioBytes: 1200 * 2 * 16,
      sampleRate: SAMPLE_RATE,
    },
  });
  const endPath = join(root, "end.json");
  writeFileSync(endPath, `${JSON.stringify(end, null, 2)}\n`, "utf8");
  const marksPath = join(root, "call-marks.json");
  writeFileSync(marksPath, `${JSON.stringify(marks, null, 2)}\n`, "utf8");
  return {
    evidence: bundle({
      marks,
      end,
      traceRows,
      wavPath: wav,
      durationMs: wavDurationMs(segments),
    }),
    wav,
    trace,
    end: endPath,
    marks: marksPath,
  };
}

test("red proof: connected before admission fails L2 and produces a defect card", async () => {
  const fixture = connectedBeforeAdmission();
  const { verdict } = await judged("L2", fixture.evidence, "golden-flow-hello");

  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.propertyId, "L2");
  assert.match(verdict.detail, /connected/i);
  assert.match(verdict.detail, /admission/i);
  assert.match(verdict.detail, /900ms/, "the gap between the paint and admission is named");

  const [card] = buildDefectCards({
    verdict: runVerdict([verdict]),
    target: "local",
    calls: [callEvidence("golden-flow-hello", fixture.wav, [fixture.trace, fixture.end, fixture.marks])],
    attributions: [{ propertyId: "L2", callId: CALL_ID, scenario: "golden-flow-hello" }],
    modules: {
      L2: ["voni/src/lib/demo/verification/verdict/evaluators/lifecycle.evaluators.ts"],
    },
    repoRoot: REPO_ROOT,
  });
  assert.ok(card);
  assert.equal(card.propertyId, "L2");
  assert.equal(card.citation.turn, null, "a connect property cites the session, not a turn");
  assert.match(card.detail, /connected/i);
});

test("red proof: a greeting-only call that ends fails C2 and C1, and a cut goodbye fails L9 with its percentage and drop", async () => {
  const fixture = greetingOnlyEnds();

  const open = await judged(
    "C2",
    fixture.evidence,
    "golden-flow-greeting-only",
    GREETING_ONLY_FACTS,
  );
  assert.equal(open.verdict.status, "FAIL");
  assert.match(open.verdict.detail, /7\.2[0-9]s|7\.21/, "the open seconds are named");
  assert.match(open.verdict.detail, /30s|30 s/, "the open bar is named");

  const unilateral = await judged(
    "C1",
    fixture.evidence,
    "golden-flow-greeting-only",
    GREETING_ONLY_FACTS,
  );
  assert.equal(unilateral.verdict.status, "FAIL");
  assert.match(unilateral.verdict.detail, /end_call|unilateral/i);

  const goodbye = await judged("L9", fixture.evidence, "golden-flow-greeting-only");
  assert.equal(goodbye.verdict.status, "FAIL");
  assert.match(goodbye.verdict.detail, /33%|0\.33|400ms/, "the played percentage is named");
  assert.match(goodbye.verdict.detail, /drop/i, "the drop delay is named");

  const cards = buildDefectCards({
    verdict: runVerdict([open.verdict, unilateral.verdict, goodbye.verdict]),
    target: "local",
    calls: [
      callEvidence("golden-flow-greeting-only", fixture.wav, [
        fixture.trace,
        fixture.end,
        fixture.marks,
      ]),
    ],
    attributions: [
      { propertyId: "C2", callId: CALL_ID, scenario: "golden-flow-greeting-only" },
      { propertyId: "C1", callId: CALL_ID, scenario: "golden-flow-greeting-only" },
      { propertyId: "L9", callId: CALL_ID, scenario: "golden-flow-greeting-only" },
    ],
    modules: {
      C1: ["voni/src/lib/demo/verification/verdict/evaluators/conduct.evaluators.ts"],
      C2: ["voni/src/lib/demo/verification/verdict/evaluators/conduct.evaluators.ts"],
      L9: ["voni/src/lib/demo/verification/verdict/evaluators/lifecycle.evaluators.ts"],
    },
    repoRoot: REPO_ROOT,
  });
  assert.deepEqual(
    cards.map((card) => card.propertyId).sort(),
    ["C1", "C2", "L9"],
    "each reported-bug property produces its own card",
  );
  const goodbyeCard = cards.find((card) => card.propertyId === "L9");
  assert.ok(goodbyeCard);
  assert.match(goodbyeCard.detail, /played/i);
  assert.match(goodbyeCard.detail, /drop/i);
});

test("the same greeting-only call passes C2 and C1 when it stays open 30 s and ends on a caller request", async () => {
  const fixture = greetingOnlyEnds();
  const marks = fixture.evidence.browser as {
    marks: { marks: { name: string; tMs: number }[]; endedAt: string };
  };
  // A fixed call stays open past 30 s; the caller asks to end and the trace
  // records a caller_end, which is an allowed ending.
  const fixedMarks = {
    ...marks.marks,
    marks: marks.marks.marks.map((mark) =>
      mark.name === "end_call_received"
        ? { ...mark, tMs: 30_900 }
        : mark.name === "end_received"
          ? { ...mark, tMs: 31_000 }
          : mark.name === "delivered_capture"
            ? { ...mark, tMs: 30_990 }
            : mark.name === "teardown"
              ? { ...mark, tMs: 31_010 }
              : mark,
    ),
    endedAt: new Date(T0 + 31_050).toISOString(),
  };
  const rows = (fixture.evidence.trace as { rows: Record<string, unknown>[] }).rows.map((row) =>
    row.type === "turn.hangup" ? { ...row, reason: "caller_end", atMs: 30_900 } : row,
  );
  const evidence: EvidenceBundle = {
    ...fixture.evidence,
    browser: { ...(fixture.evidence.browser as object), marks: fixedMarks },
    ledger: {
      ...(fixture.evidence.ledger as object),
      marks: fixedMarks,
      turns: rows.filter((row) => typeof row.turn === "string" && row.turn.trim() !== ""),
      turnIds: ["1:reply"],
    },
    trace: {
      ...(fixture.evidence.trace as object),
      rows,
    },
  };

  const open = await judged("C2", evidence, "golden-flow-greeting-only", GREETING_ONLY_FACTS);
  assert.equal(open.verdict.status, "PASS", open.verdict.detail);
  const unilateral = await judged("C1", evidence, "golden-flow-greeting-only", GREETING_ONLY_FACTS);
  assert.equal(unilateral.verdict.status, "PASS", unilateral.verdict.detail);
});

test("the same connected call passes L2 when connected paints after admission and after the first audible sample", async () => {
  const fixture = connectedBeforeAdmission();
  const browser = fixture.evidence.browser as {
    marks: { marks: { name: string; tMs: number }[]; endedAt: string };
  };
  const fixed = browser.marks.marks.map((mark) =>
    mark.name === "connected_painted" ? { ...mark, tMs: 1700 } : mark,
  );
  const fixedMarks = { ...browser.marks, marks: fixed };
  const evidence: EvidenceBundle = {
    ...fixture.evidence,
    browser: { ...(fixture.evidence.browser as object), marks: fixedMarks },
    ledger: { ...(fixture.evidence.ledger as object), marks: fixedMarks },
  };
  const { verdict } = await judged("L2", evidence, "golden-flow-hello");
  assert.equal(verdict.status, "PASS", verdict.detail);
});

type MarkArtifact = ReturnType<typeof marksOf>;

function withMarks(evidence: EvidenceBundle, marks: MarkArtifact): EvidenceBundle {
  return {
    ...evidence,
    browser: { ...(evidence.browser as object), marks },
    ledger: { ...(evidence.ledger as object), marks },
  };
}

/** A clean call: config before mic, admission before connected, audio in 300 ms. */
function cleanCall(): {
  evidence: EvidenceBundle;
  marks: MarkArtifact;
  wav: string;
  trace: string;
  end: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dv18-clean-"));
  const segments: Segment[] = [
    { kind: "silence", ms: 100 },
    { kind: "speech", ms: 1800 },
    { kind: "silence", ms: 1200 },
    { kind: "speech", ms: 1500 },
    { kind: "silence", ms: 300 },
  ];
  const wav = writeWav(join(root, "delivered.wav"), segments);
  const traceRows: Record<string, unknown>[] = [
    { type: "greeting.start", callId: CALL_ID, atMs: 500 },
    { type: "greeting.first_audio", callId: CALL_ID, atMs: 900 },
    { type: "greeting.done", callId: CALL_ID, atMs: 2700 },
    { type: "turn.reply_start", callId: CALL_ID, turn: "1:reply", atMs: 3900 },
    { type: "turn.first_audio", callId: CALL_ID, turn: "1:reply", atMs: 4000 },
    { type: "turn.hangup", callId: CALL_ID, turn: "1:reply", atMs: 4800, reason: "caller_end" },
  ];
  const trace = join(root, "trace.jsonl");
  writeFileSync(trace, traceRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const marks = marksOf(
    [
      mark("start_requested", 0),
      mark("mint_done", 100),
      mark("ringback_start", 0),
      mark("config_sent", 150),
      mark("microphone_acquired", 200),
      mark("socket_open", 220),
      mark("admitted", 500),
      mark("ringback_stop", 600),
      mark("connected_painted", 600),
      mark("first_audible", 900),
      mark("chime", 910),
      mark("talk_clock_start", 950),
      mark("turn", 4000, { role: "agent", index: 0 }),
      mark("end_received", 4800, { turns: 1 }),
      mark("delivered_capture", 4790, { name: `delivered-${CALL_ID}.wav`, complete: true }),
      mark("teardown", 4850),
    ],
    4900,
  );
  const end = endDocument({
    endedBy: "stop",
    turns: 1,
    greeting: { spoken: true, frames: 12, audioBytes: 57_600, sampleRate: SAMPLE_RATE, chime_fired: true },
  });
  const endPath = join(root, "end.json");
  writeFileSync(endPath, `${JSON.stringify(end, null, 2)}\n`, "utf8");
  return {
    evidence: bundle({ marks, end, traceRows, wavPath: wav, durationMs: wavDurationMs(segments) }),
    marks,
    wav,
    trace,
    end: endPath,
  };
}

/** A call whose agent goodbye is a complete 1200 ms line, 250 ms before drop. */
function goodbyeCall(): { evidence: EvidenceBundle; marks: MarkArtifact; wav: string } {
  const base = cleanCall();
  const segments: Segment[] = [
    { kind: "silence", ms: 100 },
    { kind: "speech", ms: 1800 },
    { kind: "silence", ms: 1200 },
    { kind: "speech", ms: 1200 },
    { kind: "silence", ms: 250 },
  ];
  const wav = writeWav(join(dirname(base.wav), "goodbye.wav"), segments);
  const marks = marksOf(
    [
      ...base.marks.marks.filter(
        (entry) =>
          !["end_received", "delivered_capture", "teardown"].includes(
            (entry as { name: string }).name,
          ),
      ),
      mark("end_call_received", 4000),
      mark("end_received", 4100, { turns: 1 }),
      mark("delivered_capture", 4090, { name: `delivered-${CALL_ID}.wav`, complete: true }),
      mark("teardown", 4110),
    ],
    4150,
  );
  const traceRows = [
    { type: "greeting.start", callId: CALL_ID, atMs: 500 },
    { type: "greeting.first_audio", callId: CALL_ID, atMs: 900 },
    { type: "greeting.done", callId: CALL_ID, atMs: 2700 },
    { type: "turn.goodbye", callId: CALL_ID, turn: "1:reply", atMs: 3950, reason: "end_call" },
    { type: "turn.hangup", callId: CALL_ID, turn: "1:reply", atMs: 4000, reason: "end_call" },
  ];
  const end = endDocument({
    endedBy: "stop",
    turns: 1,
    greeting: { spoken: true, frames: 12, audioBytes: 57_600, sampleRate: SAMPLE_RATE, chime_fired: true },
    goodbye: {
      spoken: true,
      reason: "spoken after the second failure",
      text: "Sorry, I have to end the call here. Goodbye.",
      frames: 6,
      audioBytes: 1200 * 2 * 16,
      sampleRate: SAMPLE_RATE,
    },
  });
  return {
    evidence: {
      ...bundle({
        marks,
        end,
        traceRows,
        wavPath: wav,
        durationMs: wavDurationMs(segments),
      }),
      ledger: {
        ...(base.evidence.ledger as object),
        end,
        turns: traceRows.filter((row) => typeof row.turn === "string"),
        turnIds: ["1:reply"],
        marks,
      },
    },
    marks,
    wav,
  };
}

test("L1–L11 each measure a clean browser call and cite the visitor timeline", async () => {
  const clean = cleanCall();
  const goodbye = goodbyeCall();
  const cases: {
    id: string;
    evidence: EvidenceBundle;
    scenario: string;
    detail: RegExp;
  }[] = [
    { id: "L1", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /ringback/i },
    { id: "L2", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /connected painted/i },
    { id: "L3", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /chime/i },
    { id: "L4", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /first audible/i },
    { id: "L5", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /config sent/i },
    { id: "L6", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /admission/i },
    { id: "L7", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /opening run/i },
    { id: "L8", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /talk clock/i },
    { id: "L9", evidence: goodbye.evidence, scenario: "ending-goodbye", detail: /goodbye started/i },
    { id: "L10", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /greeting succeeded/i },
    { id: "L11", evidence: clean.evidence, scenario: "golden-flow-hello", detail: /caller_end|end_call|end message/i },
  ];
  for (const entry of cases) {
    const { verdict, measurement } = await judged(entry.id, entry.evidence, entry.scenario);
    assert.equal(verdict.status, "PASS", `${entry.id}: ${verdict.detail}`);
    assert.match(measurement, entry.detail, entry.id);
  }
});

test("L1–L11 fail closed when the browser marks are missing", async () => {
  const clean = cleanCall();
  const stripped: EvidenceBundle = {
    ...clean.evidence,
    browser: { file: "none", capture: {} },
    ledger: { ...(clean.evidence.ledger as object), marks: null },
  };
  for (const id of ["L1", "L2", "L3", "L4", "L5", "L6", "L8", "L9", "L10", "L11"]) {
    const { verdict } = await judged(id, stripped, "golden-flow-hello");
    assert.equal(verdict.status, "FAIL", `${id} must fail closed without marks`);
    assert.ok(
      verdict.reason === "unmeasured" || verdict.reason === "missing-evidence",
      `${id}: ${verdict.reason}`,
    );
  }
});

test("L1 and L8 fail closed when the delivered WAV is absent", async () => {
  const clean = cleanCall();
  const noWav: EvidenceBundle = { ...clean.evidence, wav: undefined };
  for (const id of ["L1", "L8"]) {
    const { verdict } = await judged(id, noWav, "golden-flow-hello");
    assert.equal(verdict.status, "FAIL", `${id} must fail closed without the delivered audio`);
    assert.ok(
      verdict.reason === "unmeasured" || verdict.reason === "missing-evidence",
      `${id}: ${verdict.reason}`,
    );
  }
});

test("L1 never reads admission as the answer when the first voiced sample is unmarked", async () => {
  const clean = cleanCall();
  const noAudible = withMarks(
    clean.evidence,
    marksOf(
      clean.marks.marks.filter((entry) => (entry as { name: string }).name !== "first_audible"),
      8_000,
    ),
  );
  const { verdict } = await judged("L1", noAudible, "golden-flow-hello");
  assert.equal(verdict.status, "FAIL", "a ringback judged against intent alone is not a pass");
});

test("L8 fails when the talk clock starts before the delivered WAV's first voiced sample", async () => {
  const clean = cleanCall();
  const early = withMarks(
    clean.evidence,
    marksOf(
      clean.marks.marks.map((entry) =>
        (entry as { name: string }).name === "talk_clock_start"
          ? mark("talk_clock_start", 100)
          : entry,
      ),
      8_000,
    ),
  );
  const { verdict, measurement } = await judged("L8", early, "golden-flow-hello");
  assert.equal(verdict.status, "FAIL", "a clock that starts before any audible sample fails");
  assert.match(measurement, /first voiced sample/i);
});

test("L6 accepts a long voice open only when the visitor sees a named unavailable state", async () => {
  const clean = cleanCall();
  const slow = withMarks(
    clean.evidence,
    marksOf(
      clean.marks.marks.map((entry) =>
        (entry as { name: string }).name === "first_audible"
          ? mark("first_audible", 4500)
          : entry,
      ),
      8000,
    ),
  );
  const over = await judged("L6", slow, "golden-flow-hello");
  assert.equal(over.verdict.status, "FAIL", "4 s open with no named state fails");

  const refused = withMarks(
    clean.evidence,
    marksOf(
      [
        ...clean.marks.marks.filter(
          (entry) => !["first_audible", "chime"].includes((entry as { name: string }).name),
        ),
        mark("refused", 4200, { code: "unavailable" }),
      ],
      8000,
    ),
  );
  const named = await judged("L6", refused, "golden-flow-hello");
  assert.equal(named.verdict.status, "PASS", named.verdict.detail);
  assert.match(named.measurement, /unavailable|refused/i);
});

test("L10 passes only when a failed greeting names the unavailable state", async () => {
  const clean = cleanCall();
  const failedEnd = {
    ...(clean.evidence.ledger as { end: Record<string, unknown> }).end,
    error: { name: "GreetingTimedOut", stage: "greeting", message: "the greeting did not finish" },
    greeting: { spoken: false, reason: "the greeting synthesis produced no audio" },
  };
  const evidence: EvidenceBundle = {
    ...clean.evidence,
    ledger: { ...(clean.evidence.ledger as object), end: failedEnd },
  };
  const silent = await judged("L10", evidence, "golden-flow-greeting-only");
  assert.equal(silent.verdict.status, "FAIL", "a failed greeting with no named state is a silent end");

  const named = withMarks(
    evidence,
    marksOf(
      [...clean.marks.marks, mark("error_received", 1600, { code: "greeting_failed" })],
      8000,
    ),
  );
  const honest = await judged("L10", named, "golden-flow-greeting-only");
  assert.equal(honest.verdict.status, "PASS", honest.verdict.detail);
  assert.match(honest.measurement, /error_received|unavailable/i);
});

test("C2 measures the wait on a normal call and fails a short one, as ticket 19's conduct owner defines it", async () => {
  const clean = cleanCall();
  const { verdict } = await judged("C2", clean.evidence, "golden-flow-hello");
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "below-bar");
  assert.match(verdict.detail, /stayed open/i);
});
