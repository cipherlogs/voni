/**
 * Ticket 18 through the certifying run: a greeting-only call that ends exits
 * not-demo-ready with the lifecycle cards, and the same harness flips the
 * property verdicts once the evidence shows a call that stays open and plays
 * its goodbye to the end. Nothing about the harness changes between the two
 * runs; only the visitor timeline does.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadContract } from "@/lib/demo/verification/contract";
import { loadEvaluators } from "@/lib/demo/verification/verdict";
import { evaluateTriggers } from "@/lib/demo/verification/scenarios";
import type { LoadedScenario } from "@/lib/demo/verification/scenarios";
import type { CallMarksArtifact } from "@/lib/voice/call-marks";

import { runBrowserCertification, type BrowserRunInput } from "./runner";
import {
  BROWSER_CALL_ID,
  CLEAN_VENDOR_BUILDS,
  FAKE_KEYS,
  fakeStackProbe,
  removeTree,
  writeCorpus,
} from "./fixtures";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const RATE = 16_000;

type Segment = { kind: "speech" | "silence"; ms: number };

function writeWav(path: string, segments: readonly Segment[]): void {
  const samples: number[] = [];
  for (const segment of segments) {
    const count = Math.round((segment.ms / 1000) * RATE);
    for (let index = 0; index < count; index += 1) {
      samples.push(
        segment.kind === "speech"
          ? Math.round(Math.sin((2 * Math.PI * 220 * index) / RATE) * 0.25 * 32767)
          : 0,
      );
    }
  }
  const dataBytes = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataBytes, 4);
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
  bytes.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function mark(name: string, tMs: number, detail?: Record<string, unknown>) {
  return {
    name,
    at: new Date(T0 + tMs).toISOString(),
    epochMs: T0 + tMs,
    tMs,
    ...(detail ? { detail } : {}),
  };
}

function marks(
  callId: string,
  entries: readonly ReturnType<typeof mark>[],
  endedAtMs: number,
): CallMarksArtifact {
  return {
    schemaVersion: 1,
    callId,
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + endedAtMs).toISOString(),
    marks: entries,
  } as CallMarksArtifact;
}

type EvidenceKind = "buggy" | "fixed";

function writeLifecycleEvidence(input: {
  readonly kind: EvidenceKind;
  readonly eventsDir: string;
  readonly capturesDir: string;
  readonly scenario: LoadedScenario;
}): {
  callId: string;
  marksPath: string;
  capturePath: string;
  tracePath: string;
  endPath: string;
} {
  const callId = BROWSER_CALL_ID;
  mkdirSync(input.eventsDir, { recursive: true });
  mkdirSync(input.capturesDir, { recursive: true });
  const captureName = `delivered-${callId}-20261031-120000.wav`;
  const capturePath = join(input.capturesDir, captureName);
  const buggy = input.kind === "buggy";
  const endAt = buggy ? 8_010 : 31_010;

  writeWav(
    capturePath,
    buggy
      ? [
          { kind: "silence", ms: 100 },
          { kind: "speech", ms: 2_500 },
          { kind: "silence", ms: 4_000 },
          { kind: "speech", ms: 400 },
        ]
      : [
          { kind: "silence", ms: 100 },
          { kind: "speech", ms: 2_500 },
          { kind: "silence", ms: 26_000 },
          { kind: "speech", ms: 1_200 },
          { kind: "silence", ms: 250 },
        ],
  );

  const traceRows: Record<string, unknown>[] = [
    { type: "greeting.start", callId, subject: "demo:jorg", atMs: 500, phase: "connect" },
    { type: "greeting.first_audio", callId, subject: "demo:jorg", atMs: 800, phase: "connect" },
    { type: "greeting.done", callId, subject: "demo:jorg", atMs: 3_300, phase: "connect" },
    {
      type: "turn.goodbye",
      callId,
      subject: "demo:jorg",
      turn: "1:reply",
      atMs: buggy ? 7_950 : 30_950,
      phase: "drain",
      reason: "end_call",
    },
    {
      type: "turn.hangup",
      callId,
      subject: "demo:jorg",
      turn: "1:reply",
      atMs: buggy ? 8_000 : 31_000,
      phase: "drain",
      reason: buggy ? "end_call" : "caller_end",
    },
    {
      type: "cost.priced",
      callId,
      subject: "demo:jorg",
      atMs: endAt,
      phase: "drain",
      measured: true,
      totalUsd: 0.012,
    },
  ];
  const tracePath = join(input.eventsDir, `${callId}.jsonl`);
  writeFileSync(tracePath, traceRows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const endPath = join(input.eventsDir, `${callId}.end.json`);
  const end = {
    type: "end",
    callId,
    metrics: { marks: {}, gaps_ms: {}, counts: {} },
    providers: {},
    cost: { measured: true, totalUsd: 0.012 },
    eligibility: { disposition: "cascade" },
    turns: 1,
    endedBy: "stop",
    drain: { ok: true },
    bounds: [],
    greeting: { spoken: true, frames: 12, audioBytes: 80_000, sampleRate: RATE, chime_fired: true },
    ...(buggy
      ? {
          goodbye: {
            spoken: true,
            reason: "spoken after the second failure",
            text: "Sorry, I have to end the call here. Goodbye.",
            frames: 6,
            audioBytes: Math.round((1_200 / 1000) * RATE * 2),
            sampleRate: RATE,
          },
        }
      : {
          goodbye: {
            spoken: true,
            reason: "spoken after the second failure",
            text: "Sorry, I have to end the call here. Goodbye.",
            frames: 6,
            audioBytes: Math.round((1_200 / 1000) * RATE * 2),
            sampleRate: RATE,
          },
        }),
  };
  writeFileSync(endPath, `${JSON.stringify(end, null, 2)}\n`);

  const marksPath = join(input.capturesDir, `call-marks-${callId}.json`);
  const artifact = marks(
    callId,
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
      mark("first_audible", 800),
      mark("chime", 810),
      mark("talk_clock_start", buggy ? 620 : 820),
      mark("end_call_received", buggy ? 7_950 : 30_950),
      mark("end_received", buggy ? 8_000 : 31_000, { turns: 1 }),
      mark("delivered_capture", buggy ? 7_990 : 30_990, { name: captureName, complete: true }),
      mark("teardown", endAt),
    ],
    endAt + 50,
  );
  writeFileSync(marksPath, `${JSON.stringify(artifact, null, 2)}\n`);

  return { callId, marksPath, capturePath, tracePath, endPath };
}

function input(input: {
  readonly kind: EvidenceKind;
  readonly root: string;
  readonly contract: Awaited<ReturnType<typeof loadContract>>;
  readonly evaluators: Awaited<ReturnType<typeof loadEvaluators>>;
}): BrowserRunInput {
  const eventsDir = join(input.root, "events");
  const capturesDir = join(input.root, "captures");
  return {
    scenarioName: "golden-flow-greeting-only",
    target: "local",
    locale: "en",
    corpusDir: join(input.root, "corpus"),
    contract: input.contract,
    evaluators: input.evaluators,
    modules: Object.fromEntries(
      input.evaluators
        .filter((evaluator) => typeof evaluator.modulePath === "string")
        .map((evaluator) => [
          evaluator.propertyId,
          [`voni/src/lib/demo/verification/verdict/evaluators/${evaluator.modulePath}`],
        ]),
    ),
    env: FAKE_KEYS,
    appUrl: "http://127.0.0.1:3100",
    pipelineUrl: "https://127.0.0.1:8766",
    vendorBuilds: CLEAN_VENDOR_BUILDS,
    soundscapes: {},
    runRoot: join(input.root, "runs"),
    eventsDir,
    capturesDir,
    elapsedBudgetS: 120,
    repoRoot: REPO_ROOT,
    stackProbe: fakeStackProbe(),
    call: async (callInput) => {
      const written = writeLifecycleEvidence({
        kind: input.kind,
        eventsDir,
        capturesDir,
        scenario: callInput.scenario,
      });
      const timeline = [
        { atMs: 0, type: "call-open" as const },
        { atMs: 600, type: "agent-speech-start" as const },
        { atMs: 3_200, type: "agent-speech-end" as const },
        { atMs: 3_200, type: "agent-turn-end" as const },
      ];
      return {
        callId: written.callId,
        voice: "jorg",
        subject: "demo:jorg",
        startedAt: new Date(T0).toISOString(),
        endedAt: new Date(T0 + (input.kind === "buggy" ? 8_050 : 31_050)).toISOString(),
        timeline: {
          events: timeline,
          spoken: [{ step: 0, take: callInput.scenario.script[0]?.take ?? "opening", atMs: 0 }],
        },
        triggerPlan: evaluateTriggers(callInput.scenario.script, timeline),
        faultsApplied: [],
        syntheticMic: {
          method: "getUserMedia",
          installedAt: T0 - 1,
          installedBeforeAppCode: true,
          takesPlayed: [],
          sampleRate: RATE,
        },
        browser: {
          appUrl: "http://127.0.0.1:3100",
          pipelineWsUrl: "wss://localhost:8766/v1/browser-call",
          userAgent: "test-chromium",
          markCount: 15,
          captureName: `delivered-${written.callId}-20261031-120000.wav`,
        },
        marksPath: written.marksPath,
        capturePath: written.capturePath,
        endedBy: "agent-end",
        error: null,
        tracePath: written.tracePath,
        endPath: written.endPath,
        elapsedMs: input.kind === "buggy" ? 8_100 : 31_100,
      };
    },
  };
}

test("a greeting-only call that ends exits not-demo-ready with lifecycle cards, and a fixed timeline flips them", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv18-runner-"));
  try {
    writeCorpus(join(root, "corpus"), [
      {
        name: "golden-flow-greeting-only",
        expectedProperties: ["C1", "C2", "L4", "L7", "L9", "L10"],
        text: "Hi, is this Voni?",
      },
    ]);
    const contract = await loadContract();
    const evaluators = await loadEvaluators(contract);
    // The fake harness makes one call, as a diagnose run does. Narrow the
    // sample plan for the lifecycle/conduct properties to that one call so the
    // evidence flip is judged, not a repetition shortfall; a production run
    // keeps the contract's three repetitions and still fails a short plan.
    const narrowed = {
      ...contract,
      properties: contract.properties.map((property) =>
        property.id.startsWith("L") || property.id === "C1" || property.id === "C2"
          ? { ...property, repetitions: 1 as const }
          : property,
      ),
    };

    const buggy = await runBrowserCertification(
      input({ kind: "buggy", root, contract: narrowed, evaluators }),
    );
    assert.equal(buggy.status, "not-demo-ready", buggy.unrun.join("; "));
    assert.equal(buggy.exitCode, 1);
    const buggyCards = buggy.cards.map((card) => card.propertyId);
    const c1Verdict = buggy.verdict?.properties.find((property) => property.propertyId === "C1");
    assert.ok(
      buggyCards.length > 0,
      `no cards; gaps: ${buggy.cardGaps.map((gap) => `${gap.propertyId}:${gap.code}:${gap.detail}`).join(" | ")}; ` +
        `C1=${c1Verdict?.status}/${c1Verdict?.reason}: ${c1Verdict?.detail}`,
    );
    for (const id of ["C1", "C2", "L9"]) {
      const property = buggy.verdict?.properties.find((entry) => entry.propertyId === id);
      assert.ok(
        buggyCards.includes(id),
        `expected a ${id} card, saw ${buggyCards.join(", ")}; ` +
          `${id}=${property?.status}/${property?.reason}: ${property?.detail}; ` +
          `gaps=${buggy.cardGaps.filter((gap) => gap.propertyId === id).map((gap) => `${gap.code}:${gap.detail}`).join("|")}`,
      );
    }
    const c2 = buggy.verdict?.properties.find((property) => property.propertyId === "C2");
    assert.equal(c2?.status, "FAIL");

    const fixed = await runBrowserCertification(
      input({ kind: "fixed", root, contract: narrowed, evaluators }),
    );
    assert.equal(fixed.status, "not-demo-ready", "unlanded families still fail closed");
    const fixedC2 = fixed.verdict?.properties.find((property) => property.propertyId === "C2");
    assert.equal(fixedC2?.status, "PASS", fixedC2?.detail);
    const fixedL9 = fixed.verdict?.properties.find((property) => property.propertyId === "L9");
    assert.equal(fixedL9?.status, "PASS", fixedL9?.detail);
    const fixedCards = fixed.cards.map((card) => card.propertyId);
    for (const id of ["C1", "C2", "L9"]) {
      assert.ok(!fixedCards.includes(id), `the fixed run still has a ${id} card`);
    }
  } finally {
    removeTree(root);
  }
});
