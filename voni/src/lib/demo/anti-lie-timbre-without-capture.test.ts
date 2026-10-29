/**
 * Anti-lie: no delivered audio, no timbre pass (meta-cascade M4, ticket 144).
 *
 * ADR 0009: a timbre claim without delivered audio is invalid. There are two
 * ways a claim can dodge that rule, and this file pins both:
 *
 * 1. **The "delivered" file is the reference render.** The measurement then
 *    compares a file with itself, every axis agrees, and the gate would PASS on
 *    a delivery that never happened. The six-axis result must refuse it by
 *    name, and the gate must report FAIL with that reason.
 * 2. **The artifact records no delivered capture.** It may record the reference
 *    only, or pass the same file under both legs; the reader refuses the second
 *    and the run verdict refuses the first, so green is unreachable.
 *
 * Every fixture here is otherwise a green candidate: the level leg agrees, the
 * probes are zero, the agent channel is clean, the stored body is present and
 * two raters filed 5/5 ballots on one recording. Only the delivered capture is
 * missing or faked, so if this file passes with the refusal deleted, the
 * refusal is the only thing standing between a lie and a PASS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  DEFAULT_GATE_VOICE,
  STREAK_REQUIRED_GATES,
  addHumanRating,
  buildSkeletonArtifact,
  emptyHumanRatings,
  evaluateTimbreGate,
  type HumanRatings,
  type ScoreboardArtifact,
  type ScoreboardGate,
} from "./scoreboard";
import {
  checkMeasuredLevel,
  measureTimbre,
  type MeasuredLevelFile,
} from "./timbre-measurement";
import { parseServedDemoAgentBody } from "./stored-agents";
import { decodePcm, type DecodedAudio } from "../audio/format-facts";
import { ArtifactReadError, deriveRunEligibility, parseScoreboardArtifact } from "./artifact-reader";

const SAMPLE_RATE = 24_000;
const SERVED_LEVEL = 100;

/** A one-second tone at a chosen RMS, so the level leg has a real reading. */
function measuredTone(path: string, rmsDbfs: number, frames = SAMPLE_RATE): MeasuredLevelFile {
  const bytes = Buffer.alloc(frames * 2);
  const amplitude = 32_768 * 10 ** (rmsDbfs / 20) * Math.SQRT2;
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 1000 * frame) / SAMPLE_RATE));
    bytes.writeInt16LE(Math.max(-32_768, Math.min(32_767, value)), frame * 2);
  }
  return { path, audio: decodePcm(bytes, { sampleRate: SAMPLE_RATE, channels: 1 }) };
}

const reference = () => measuredTone("captures/reference-anna-en.wav", -23.1);
const delivered = () => measuredTone("captures/delivered-anna-en.wav", -23.2);

/** The same samples under a second path: a copy is not a delivery either. */
function copyOf(file: MeasuredLevelFile, path: string): MeasuredLevelFile {
  const audio: DecodedAudio = {
    samples: file.audio.samples.slice(),
    facts: { ...file.audio.facts },
  };
  return { path, audio };
}

const ZERO_PROBES = { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 };
const CLEAN_CHANNEL = { peakDbfs: -7.2, clippedSampleRatio: 0, largestAdjacentStep: 120 };

function servedBody(volume = SERVED_LEVEL) {
  const parsed = parseServedDemoAgentBody(
    "agent_stored",
    { input: { turn_detection: null }, output: { volume } },
    "fp_stored",
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return { measured: true as const, body: parsed.body, agentId: "agent_stored", fingerprint: "fp_stored" };
}

function passingBallots(recording = "c".repeat(64)): HumanRatings {
  const one = addHumanRating(
    emptyHumanRatings(recording),
    { rater: "ana", timbre: 5, accent: 5 },
    recording,
  );
  return addHumanRating(one, { rater: "bob", timbre: 5, accent: 5 }, recording);
}

/** The gate with every leg passing except the delivered capture. */
function gateWith(measuredLevel: { reference: MeasuredLevelFile | null; delivered: MeasuredLevelFile | null }) {
  return evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(),
    measuredLevel: measuredLevel as never,
    humanRatings: passingBallots(),
  });
}

/** An otherwise-green cascade artifact whose timbre gate claims PASS. */
function greenCascade(captures: Record<string, unknown>): ScoreboardArtifact {
  const base = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 1000,
    runs: 1,
    dryRun: true,
    runId: "run-timbre-lie",
    codeFingerprint: { head: "a".repeat(40), dirty: false, dirtyHash: "0".repeat(64) },
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
      finishedAt: "2026-10-29T10:00:01.000Z",
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
    captures: captures as never,
    eligibility: { eligible: true },
    gates: STREAK_REQUIRED_GATES.map(
      (name): ScoreboardGate => ({ name, status: "PASS", detail: "measured" }) as ScoreboardGate,
    ),
  } as ScoreboardArtifact;
}

function capture(path: string, sha256 = "a".repeat(64)) {
  return { path, sha256 };
}

test("a timbre result whose delivered file is the reference never passes", () => {
  const file = reference();
  const result = measureTimbre({ reference: file, delivered: file });

  assert.notEqual(result.status, "PASS", result.detail);
  assert.equal(result.status, "FAIL");
  assert.equal(result.refusals.length, 1, result.detail);
  assert.match(result.refusals[0] ?? "", /reference render/);
  assert.match(result.refusals[0] ?? "", /delivered audio/);
  assert.match(result.refusals[0] ?? "", /ADR 0009/);
  assert.deepEqual(result.failures, [], "no axis was measured, so no axis 'failed'");
});

test("a copy of the reference under a delivered path is still not a delivery", () => {
  const referenceFile = reference();
  const result = measureTimbre({
    reference: referenceFile,
    delivered: copyOf(referenceFile, "captures/delivered-anna-en.wav"),
  });

  assert.notEqual(result.status, "PASS", result.detail);
  assert.equal(result.status, "FAIL");
  assert.match(result.refusals[0] ?? "", /identical/);
});

test("the same-file pair would pass every axis, so the refusal is the only thing refusing it", () => {
  // This is the lie's arithmetic: a file compared with itself agrees perfectly.
  // Deleting the refusal in `measureTimbre` makes the case above PASS, because
  // nothing else in the six axes can see that no delivery happened.
  const file = reference();
  const level = checkMeasuredLevel({ reference: file, delivered: file });
  assert.equal(level.status, "PASS", level.detail);
  assert.equal(level.deltaLu, 0);

  const result = measureTimbre({ reference: file, delivered: file });
  assert.equal(result.status, "FAIL");
});

test("the timbre gate reports FAIL with the reason, never PASS", () => {
  const file = reference();
  const gate = gateWith({ reference: file, delivered: file });

  assert.equal(gate.name, "timbre-probes");
  assert.notEqual(gate.status, "PASS", gate.detail);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /reference render/);
  assert.match(gate.detail, /delivered audio/);
});

test("a run with no delivered capture cannot pass the timbre gate", () => {
  const gate = gateWith({ reference: reference(), delivered: null });

  assert.notEqual(gate.status, "PASS", gate.detail);
  assert.equal(gate.status, "INFO");
  assert.match(gate.detail, /no delivered capture file/);
});

test("a real delivered capture still passes the gate, so the refusal is narrow", () => {
  const gate = gateWith({ reference: reference(), delivered: delivered() });

  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /captures\/delivered-anna-en\.wav/);
});

test("an artifact that records the reference file as its delivered capture is refused by name", () => {
  const raw = greenCascade({
    reference: capture("captures/reference-anna-en.wav"),
    platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
    delivered: capture("captures/reference-anna-en.wav"),
  });

  assert.throws(
    () => parseScoreboardArtifact(raw, "reference-as-delivered.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "captures.delivered" &&
      /reference/.test(error.message) &&
      /never the reference render/.test(error.message),
  );
});

test("an artifact with only a reference capture is not green, and the verdict says why", () => {
  const artifact = greenCascade({
    reference: capture("captures/reference-anna-en.wav"),
    platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
  });

  const verdict = deriveRunEligibility({ artifact });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.disposition, "rerun");
  assert.match(verdict.reasons.join(" "), /timbre-probes.*delivered capture is missing/);
});

test("a delivered capture whose bytes changed is dirty evidence, not a pass", () => {
  const sha = createHash("sha256").update("the delivered bytes").digest("hex");
  const artifact = greenCascade({
    reference: capture("captures/reference-anna-en.wav"),
    platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
    delivered: capture("captures/delivered-anna-en.wav", sha),
  });

  const verdict = deriveRunEligibility({
    artifact,
    captureIO: { read: () => Buffer.from("some other bytes") },
  });

  assert.equal(verdict.eligible, false);
  assert.match(verdict.reasons.join(" "), /delivered capture is dirty/);
  assert.match(verdict.reasons.join(" "), /sha256/);
});
