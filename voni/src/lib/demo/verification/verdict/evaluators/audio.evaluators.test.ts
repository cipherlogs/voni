import test from "node:test";
import assert from "node:assert/strict";

import { loadContract, requireProperty } from "../../contract";
import type { Contract } from "../../contract";
import { loadEvaluators } from "../evaluators";
import type {
  Evaluation,
  EvidenceBundle,
  PropertyEvaluator,
} from "../types";
import { loadVoiceReference } from "@/lib/audio/voice-reference";
import { SCOREBOARD_BUDGETS } from "@/lib/demo/scoreboard-budgets";

import {
  click,
  clipped,
  fade,
  hole,
  writeWav,
} from "../audio/test-pcm";

/**
 * A1-A8 through the real evaluator module and the real contract. Every break
 * is a known synthetic break, and every pass is a copy of the committed voice
 * reference, so an evaluator cannot pass by measuring its own arithmetic.
 */

let contract: Contract;
let evaluators: PropertyEvaluator[];
let reference: ReturnType<typeof loadVoiceReference>;

async function init(): Promise<void> {
  if (contract !== undefined) return;
  contract = await loadContract();
  evaluators = await loadEvaluators(contract);
  reference = loadVoiceReference();
}

function withAudio(name: string, fn: () => void | Promise<void>): void {
  test(name, async () => {
    await init();
    await fn();
  });
}

function evaluatorFor(id: string): PropertyEvaluator {
  const evaluator = evaluators.find((entry) => entry.propertyId === id);
  assert.ok(evaluator, `no evaluator registered for ${id}`);
  return evaluator;
}

function noisyCopy(samples: Int16Array, amplitude = 1): Int16Array {
  const copy = new Int16Array(samples.length);
  for (let index = 0; index < copy.length; index += 1) {
    const noise = ((index % 7) - 3) * amplitude;
    copy[index] = Math.max(-32768, Math.min(32767, samples[index]! + noise));
  }
  return copy;
}

function audioEvidence(samples: Int16Array, name = "delivered.wav") {
  const audio = {
    samples,
    facts: { ...reference.audio.facts, frameCount: samples.length, dataBytes: samples.length * 2 },
  };
  const file = writeWav(name, audio);
  return {
    wav: {
      file,
      sampleRate: audio.facts.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      frames: samples.length,
      durationMs: (samples.length / audio.facts.sampleRate) * 1000,
      bytes: 44 + samples.length * 2,
    },
    browser: { capture: { file, bytes: 44 + samples.length * 2, sampleRate: audio.facts.sampleRate, seconds: samples.length / audio.facts.sampleRate } },
  };
}

async function evaluate(
  id: string,
  evidence: EvidenceBundle,
  facts?: { takes: { id: string; text: string | null }[] },
): Promise<Evaluation> {
  const evaluator = evaluatorFor(id);
  const property = requireProperty(contract, id);
  return evaluator.evaluate({
    property,
    scenario: "fixture",
    repetition: 1,
    source: evidence[property.evidence],
    evidence,
    ...(facts === undefined ? {} : { facts }),
  });
}

function cleanAudio() {
  return { samples: noisyCopy(reference.audio.samples), facts: { ...reference.audio.facts } };
}

function cleanEvidence() {
  return audioEvidence(cleanAudio().samples);
}

function samplesOf(evaluation: Evaluation): readonly number[] {
  assert.equal(evaluation.kind, "measured", JSON.stringify(evaluation));
  return evaluation.kind === "measured" ? (evaluation.samples ?? []) : [];
}

withAudio("the registry registers one evaluator for every audio property with its frozen keys", () => {
  for (let index = 1; index <= 8; index += 1) {
    const id = `A${index}`;
    const evaluator = evaluatorFor(id);
    const property = requireProperty(contract, id);
    assert.deepEqual(
      evaluator.bars.map((bar) => bar.key).sort(),
      property.thresholds.map((threshold) => threshold.key).sort(),
      `${id} binds every frozen key`,
    );
  }
});

withAudio("A1 passes a clean delivery and fails a dropout or a click with its time", async () => {
  const passing = await evaluate("A1", cleanEvidence());
  assert.equal(samplesOf(passing)[0], 0);

  const dropout = audioEvidence(hole(cleanAudio(), 1, 1.05).samples);
  const dropped = await evaluate("A1", dropout);
  assert.equal(samplesOf(dropped)[0], 1);
  assert.ok(samplesOf(dropped)[1]! > 0);
  assert.match(dropped.kind === "measured" ? dropped.detail ?? "" : "", /1000ms/);

  const clicked = audioEvidence(click(cleanAudio(), 0.5).samples);
  const clickedResult = await evaluate("A1", clicked);
  assert.equal(samplesOf(clickedResult)[0], 1);
  assert.match(clickedResult.kind === "measured" ? clickedResult.detail ?? "" : "", /click/);
});

withAudio("A1 allows a 20 ms hole and A8 counts it as a silent frame", async () => {
  const twenty = audioEvidence(hole(cleanAudio(), 1, 1.02).samples);
  assert.equal(samplesOf(await evaluate("A1", twenty))[0], 0);
  assert.ok(samplesOf(await evaluate("A8", twenty))[0]! >= 2);
});

withAudio("A2 passes a described WAV and refuses a misdescribed one", async () => {
  const evidence = cleanEvidence();
  const passing = await evaluate("A2", evidence);
  assert.deepEqual(samplesOf(passing), [0]);

  const broken = { ...evidence, wav: { ...evidence.wav, sampleRate: 48_000 } };
  const refusal = await evaluate("A2", broken);
  assert.equal(refusal.kind, "unmeasured");
  assert.match(refusal.kind === "unmeasured" ? refusal.reason : "", /wav-misdescribed/);
});

withAudio("A3 passes a clean level and fails a loud delivery and a pumped one", async () => {
  const passing = await evaluate("A3", cleanEvidence());
  assert.ok(Math.abs(samplesOf(passing)[0]!) < SCOREBOARD_BUDGETS.timbreLufsToleranceDb.value);

  const loud = Int16Array.from(reference.audio.samples, (sample) =>
    Math.max(-32768, Math.min(32767, Math.round(sample * 4))),
  );
  const loudResult = await evaluate("A3", audioEvidence(loud));
  assert.ok(samplesOf(loudResult)[0]! > SCOREBOARD_BUDGETS.timbreLufsToleranceDb.value);

  const pumped = new Int16Array(reference.audio.samples.length);
  for (let index = 0; index < pumped.length; index += 1) {
    const seconds = index / reference.audio.facts.sampleRate;
    const gain = 1 + 0.35 * Math.sin(2 * Math.PI * 20 * seconds);
    pumped[index] = Math.max(-32768, Math.min(32767, Math.round(reference.audio.samples[index]! * gain)));
  }
  const pumpedResult = await evaluate("A3", audioEvidence(pumped));
  assert.ok(samplesOf(pumpedResult)[1]! > SCOREBOARD_BUDGETS.comparisonModulationDepth.value);
});

withAudio("A5 maps every timbre axis to its own frozen bar", async () => {
  const clean = await evaluate("A5", cleanEvidence());
  const samples = samplesOf(clean);
  assert.equal(samples.length, 6);
  assert.ok(samples[0]! <= SCOREBOARD_BUDGETS.timbreMeasuredTruePeakDbtp.value);
  assert.ok(samples[1]! <= SCOREBOARD_BUDGETS.timbreMeasuredDistortionDb.value);
  assert.ok(samples[2]! >= SCOREBOARD_BUDGETS.timbreMeasuredCrestMin.value);
  assert.ok(samples[3]! <= SCOREBOARD_BUDGETS.timbreMeasuredBandDeltaDb.value);
  assert.ok(samples[4]! <= SCOREBOARD_BUDGETS.timbreMeasuredBreakupMax.value);
  assert.equal(samples[5], SCOREBOARD_BUDGETS.timbreMeasuredBreakupMatchSeconds.value);

  const clippedResult = await evaluate(
    "A5",
    audioEvidence(clipped(cleanAudio(), 1, 8).samples),
  );
  assert.ok(samplesOf(clippedResult)[0]! > SCOREBOARD_BUDGETS.timbreMeasuredTruePeakDbtp.value);

  const shaped = new Int16Array(reference.audio.samples.length);
  for (let index = 0; index < shaped.length; index += 1) {
    const base = reference.audio.samples[index]! / 32768;
    const harmonic = 0.01 * Math.sin((2 * Math.PI * 660 * index) / reference.audio.facts.sampleRate);
    shaped[index] = Math.round(Math.max(-1, Math.min(1, base + harmonic)) * 32767);
  }
  const distorted = await evaluate("A5", audioEvidence(shaped));
  assert.ok(samplesOf(distorted)[1]! > SCOREBOARD_BUDGETS.timbreMeasuredDistortionDb.value);

  const holed = await evaluate("A5", audioEvidence(hole(cleanAudio(), 1, 1.05).samples));
  assert.ok(samplesOf(holed)[4]! > SCOREBOARD_BUDGETS.timbreMeasuredBreakupMax.value);

  const square = new Int16Array(reference.audio.samples.length);
  for (let index = 0; index < square.length; index += 1) {
    square[index] = reference.audio.samples[index]! >= 0 ? 20_000 : -20_000;
  }
  const squared = await evaluate("A5", audioEvidence(square));
  assert.ok(samplesOf(squared)[2]! < SCOREBOARD_BUDGETS.timbreMeasuredCrestMin.value);

  const low = new Int16Array(reference.audio.samples.length);
  for (let index = 0; index < low.length; index += 1) {
    const seconds = index / reference.audio.facts.sampleRate;
    low[index] = Math.round(0.2 * 32767 * Math.sin(2 * Math.PI * 90 * seconds));
  }
  const lowBand = await evaluate("A5", audioEvidence(low));
  assert.ok(samplesOf(lowBand)[3]! > SCOREBOARD_BUDGETS.timbreMeasuredBandDeltaDb.value);
});

withAudio("A6 passes a clean delivery and fails an underrun or an overrun", async () => {
  const passing = await evaluate("A6", cleanEvidence());
  assert.deepEqual(samplesOf(passing), [0, 0]);

  const underrun = await evaluate(
    "A6",
    audioEvidence(hole(cleanAudio(), 1.2, 1.25).samples),
  );
  assert.equal(samplesOf(underrun)[0], 1);

  const overrun = await evaluate(
    "A6",
    audioEvidence(clipped(cleanAudio(), 1, 8).samples),
  );
  assert.equal(samplesOf(overrun)[1], 1);
});

withAudio("A7 reads a short barge fade, refuses a long one and counts a pop", async () => {
  const trace = { rows: [{ type: "turn.cut", turn: "0:0", atMs: 1000, reason: "barge_in" }] };
  const short = await evaluate("A7", {
    ...audioEvidence(fade(cleanAudio(), 3, 60).samples),
    trace,
  });
  assert.ok(samplesOf(short)[0]! <= SCOREBOARD_BUDGETS.dvBargeInFadeMaxMs.value);
  assert.equal(samplesOf(short)[1], 0);

  const long = await evaluate("A7", {
    ...audioEvidence(fade(cleanAudio(), 3, 200).samples),
    trace,
  });
  assert.ok(samplesOf(long)[0]! > SCOREBOARD_BUDGETS.dvBargeInFadeMaxMs.value);

  const popped = await evaluate("A7", {
    ...audioEvidence(click(fade(cleanAudio(), 3, 60), 2.97).samples),
    trace,
  });
  assert.ok(samplesOf(popped)[1]! >= 1);
});

withAudio("A7 fails closed when the call recorded no barge-in cut", async () => {
  const result = await evaluate("A7", {
    ...audioEvidence(fade(cleanAudio(), 3, 60).samples),
    trace: { rows: [] },
  });
  assert.equal(result.kind, "unmeasured");
  assert.match(result.kind === "unmeasured" ? result.reason : "", /no barge-in cut/);
});

withAudio("A8 passes a clean delivery and counts the frames silence replaced", async () => {
  assert.equal(samplesOf(await evaluate("A8", cleanEvidence()))[0], 0);

  const holed = await evaluate(
    "A8",
    audioEvidence(hole(cleanAudio(), 1.2, 1.25).samples),
  );
  assert.ok(samplesOf(holed)[0]! >= 4);
  assert.match(holed.kind === "measured" ? holed.detail ?? "" : "", /1000 ms/);
});

withAudio("A4 fails closed when the trace carries no caller words", async () => {
  const result = await evaluate("A4", {
    trace: {
      rows: [
        { type: "turn.user_final", turn: "0:0", atMs: 1_000, chars: 12, empty: false },
        { type: "turn.reply_start", turn: "0:0", atMs: 1_200 },
      ],
    },
  });
  assert.equal(result.kind, "unmeasured");
  assert.match(result.kind === "unmeasured" ? result.reason : "", /echo-unmeasurable/);
});

withAudio("A4 counts a caller final that repeats the agent's own words", async () => {
  const result = await evaluate("A4", {
    trace: {
      rows: [
        { type: "turn.reply_start", turn: "0:0", atMs: 1_000, text: "Let me show you what I can do while we talk" },
        { type: "turn.user_final", turn: "0:0", atMs: 1_500, text: "what I can do while we talk", chars: 27, empty: false },
        { type: "turn.user_final", turn: "0:1", atMs: 3_000, text: "yes please", chars: 10, empty: false },
        { type: "turn.reply_start", turn: "0:1", atMs: 2_800, text: "Ready to try the email test" },
      ],
    },
  });
  assert.deepEqual(samplesOf(result), [1]);
});

withAudio("every audio evaluator refuses a missing WAV before measurement", async () => {
  for (let index = 1; index <= 8; index += 1) {
    if (index === 4) continue;
    const result = await evaluate(`A${index}`, { wav: { file: "/no/such/delivered.wav" } });
    assert.equal(result.kind, "unmeasured", `A${index} must refuse a missing WAV`);
  }
});
