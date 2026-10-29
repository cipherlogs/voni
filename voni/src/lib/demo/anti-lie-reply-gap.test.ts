import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  DEFAULT_GATE_VOICE,
  REPLY_GAP_P50_BUDGET_MS,
  REPLY_GAP_P95_BUDGET_MS,
  buildSkeletonArtifact,
  replyGapGate,
  type ReplyGapSample,
} from "./scoreboard";
import { SCOREBOARD_BUDGETS } from "./scoreboard-budgets";
import { ArtifactReadError, parseScoreboardArtifact } from "./artifact-reader";

/**
 * Anti-lie: a reply gap over the frozen budget cannot pass (M18 / ticket 145).
 *
 * Expected values come from the committed budget record, not from this file:
 * the boundary samples are derived from `scoreboard-budgets.json` and the one
 * TS table, so a gate that reads a second (different) source, or a comparison
 * that is inverted, fails here instead of shipping a green run.
 */

/** The committed record, read independently of the gate's module. */
const BUDGET_RECORD = JSON.parse(
  readFileSync(new URL("./scoreboard-budgets.json", import.meta.url), "utf8"),
) as { budgets: Record<string, number> };

function sample(gapMs: number, turnIndex: number | null = null): ReplyGapSample {
  return { beat: null, gapMs, turnIndex };
}

function samplesAt(gapMs: number, count = 3): ReplyGapSample[] {
  return Array.from({ length: count }, (_, index) => sample(gapMs, index + 1));
}

/** A cascade artifact carrying every section of the one shared shape (M12). */
function capture(name: string) {
  return { path: `artifacts/${name}.wav`, sha256: "a".repeat(64) };
}

function cascadeArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 1000,
    runs: 1,
    dryRun: true,
    gaps: {},
    codeFingerprint: { head: "f7d1d4e2abcdef", dirty: false, dirtyHash: "0".repeat(64) },
    runId: "run-anti-lie",
  });
  return {
    ...(JSON.parse(JSON.stringify(base)) as Record<string, unknown>),
    pipeline: "cascade",
    subject: {
      agent: { kind: "demo", voice: "anna", agentId: null },
      locale: "en",
      transport: "browser",
      source: "flag",
    },
    run: {
      runId: base.runId,
      variant: "cascade-anna-1",
      startedAt: "2026-10-29T10:00:00.000Z",
      finishedAt: "2026-10-29T10:00:03.000Z",
    },
    providers: { stt: "assemblyai-meta", llm: "meta-llama-3.3", tts: "meta-speech" },
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
    ...overrides,
  };
}

/** A measured cascade gap: the ledger marks and the row they derive. */
function measuredGap(gapMs: number, marks: Record<string, number> = {}) {
  return cascadeArtifact({
    ledger: {
      marks: {
        audio_in: 1,
        first_partial: 1.18,
        speech_complete: 10,
        first_token: 10.24,
        first_playout: 10 + gapMs / 1000,
        ...marks,
      },
      counts: {},
    },
    latency: {
      screenToFirstPartialMs: 180,
      speechCompleteToFirstTokenMs: 240,
      replyGapP50Ms: gapMs,
      commitToFirstPlayoutMs: { absent: "N/A — the cascade has no commit mark" },
    },
  });
}

test("the gate judges the frozen record, not a second copy of the number", () => {
  assert.equal(BUDGET_RECORD.budgets.replyGapP50Ms, SCOREBOARD_BUDGETS.replyGapP50Ms.value);
  assert.equal(BUDGET_RECORD.budgets.replyGapP95Ms, SCOREBOARD_BUDGETS.replyGapP95Ms.value);
  assert.equal(REPLY_GAP_P50_BUDGET_MS, BUDGET_RECORD.budgets.replyGapP50Ms);
  assert.equal(REPLY_GAP_P95_BUDGET_MS, BUDGET_RECORD.budgets.replyGapP95Ms);
});

test("a sample set over the median budget but under the tail budget fails the median gate", () => {
  const median = BUDGET_RECORD.budgets.replyGapP50Ms;
  const tail = BUDGET_RECORD.budgets.replyGapP95Ms;
  const gap = median + 1;
  assert.ok(gap < tail, "the fixture must stay inside the tail budget");

  const gate = replyGapGate(samplesAt(gap));

  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, new RegExp(`p50 ${gap}ms > ${median}ms`));
});

test("a set exactly at the median budget passes and one millisecond over fails", () => {
  const median = BUDGET_RECORD.budgets.replyGapP50Ms;

  assert.equal(replyGapGate(samplesAt(median)).status, "PASS");
  assert.equal(replyGapGate(samplesAt(median + 1)).status, "FAIL");
});

test("an artifact that substitutes the final mark for the reply-gap anchor is refused by name", () => {
  const faked = cascadeArtifact({
    ledger: {
      marks: {
        audio_in: 1,
        first_partial: 1.18,
        speech_complete: 10,
        first_token: 10.24,
        final: 10.9,
      },
      counts: {},
    },
    latency: {
      screenToFirstPartialMs: 180,
      speechCompleteToFirstTokenMs: 240,
      replyGapP50Ms: 900,
      commitToFirstPlayoutMs: { absent: "N/A — the cascade has no commit mark" },
    },
  });

  assert.throws(
    () => parseScoreboardArtifact(faked, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.replyGapP50Ms" &&
      /first_playout/.test(error.message) &&
      /never borrowed/.test(error.message),
  );
});

test("an artifact that hides a missing speech_complete mark is refused by name", () => {
  const hidden = cascadeArtifact({
    ledger: {
      marks: { audio_in: 1, first_partial: 1.18, first_token: 10.24, first_playout: 10.9 },
      counts: {},
    },
    latency: {
      screenToFirstPartialMs: 180,
      speechCompleteToFirstTokenMs: 240,
      replyGapP50Ms: 900,
      commitToFirstPlayoutMs: { absent: "N/A — the cascade has no commit mark" },
    },
  });

  assert.throws(
    () => parseScoreboardArtifact(hidden, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.speechCompleteToFirstTokenMs" &&
      /speech_complete/.test(error.message),
  );
});

test("a gap the ledger measured survives the reader and still fails over budget", () => {
  const median = BUDGET_RECORD.budgets.replyGapP50Ms;
  const artifact = measuredGap(median + 100);

  const parsed = parseScoreboardArtifact(artifact, "cascade.json");
  const recorded = (parsed.latency as Record<string, unknown>).replyGapP50Ms;
  assert.equal(recorded, median + 100);

  const gate = replyGapGate(samplesAt(recorded as number));
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, new RegExp(`p50 ${median + 100}ms > ${median}ms`));
});

test("a missing reply-gap mark is a named N/A and never a pass", () => {
  const artifact = cascadeArtifact({
    ledger: { marks: { audio_in: 1 }, counts: {} },
    latency: {
      screenToFirstPartialMs: { absent: 'N/A — the cascade ledger has no "first_partial" mark' },
      speechCompleteToFirstTokenMs: { absent: 'N/A — the cascade ledger has no "speech_complete" mark' },
      replyGapP50Ms: {
        absent: 'N/A — the cascade ledger has no "speech_complete" or "first_playout" mark',
      },
      commitToFirstPlayoutMs: { absent: "N/A — the cascade has no commit mark" },
    },
  });

  const parsed = parseScoreboardArtifact(artifact, "cascade.json");
  const recorded = (parsed.latency as Record<string, unknown>).replyGapP50Ms;
  assert.ok(typeof recorded === "object" && recorded !== null);
  assert.match((recorded as { absent: string }).absent, /speech_complete/);

  const gate = replyGapGate([]);
  assert.notEqual(gate.status, "PASS");
});
