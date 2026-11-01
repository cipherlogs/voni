import test from "node:test";
import assert from "node:assert/strict";

import type { DecodedAudio } from "@/lib/audio/format-facts";
import { loadVoiceReference } from "@/lib/audio/voice-reference";

import { alignToReference, compareTimbre, TimbreComparisonError } from "./compare";
import { measureTimbre } from "@/lib/demo/timbre-measurement";
import { fade, hole, tone, writeWav } from "./test-pcm";

/** One axis's result, from the six-axis measurement the gate consumes. */
function axisOf(
  reference: DecodedAudio,
  delivered: DecodedAudio,
  axis: string,
): { verdict: string; value: number | null } {
  const measured = measureTimbre({
    reference: { path: "ref.wav", audio: reference },
    delivered: { path: "del.wav", audio: delivered },
  });
  const entry = measured.axes.find((candidate) => candidate.axis === axis);
  assert.ok(entry, `the measurement carries the ${axis} axis`);
  return { verdict: entry.verdict, value: entry.value };
}

function copyWithNoise(audio: DecodedAudio, amplitude = 1): DecodedAudio {
  const samples = new Int16Array(audio.samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const noise = (index % 7) - 3;
    samples[index] = Math.max(-32768, Math.min(32767, audio.samples[index]! + noise * amplitude));
  }
  return { samples, facts: { ...audio.facts } };
}

function referencePair() {
  const committed = loadVoiceReference();
  const deliveredAudio = copyWithNoise(committed.audio);
  const deliveredPath = writeWav("delivered.wav", deliveredAudio);
  return { committed, deliveredAudio, deliveredPath };
}

/** The same samples, heard `ms` late: a lead-in, not a different recording. */
function delayed(audio: DecodedAudio, ms: number): DecodedAudio {
  const delay = Math.round((ms / 1000) * audio.facts.sampleRate);
  const samples = new Int16Array(audio.samples.length + delay);
  samples.set(audio.samples, delay);
  return {
    samples,
    facts: {
      ...audio.facts,
      frameCount: samples.length,
      dataBytes: samples.length * 2,
      durationSeconds: samples.length / audio.facts.sampleRate,
    },
  };
}

/**
 * The same speech statistics in a different waveform: what a fresh synthesis
 * of the same line delivers. The blocks are rotated, so no sample aligns.
 */
function reRendered(audio: DecodedAudio): DecodedAudio {
  const half = Math.floor(audio.samples.length / 2);
  const tail = Math.round(audio.facts.sampleRate * 0.5);
  const rotation = new Int16Array(audio.samples.length + tail);
  for (let index = 0; index < audio.samples.length; index += 1) {
    rotation[index] = audio.samples[(index + half) % audio.samples.length]!;
  }
  // A few extra frames keep the surrogate longer than the reference line, so
  // the truncation refusal does not stand in for the comparability question.
  rotation.set(audio.samples.subarray(0, tail), audio.samples.length);
  return {
    samples: rotation,
    facts: {
      ...audio.facts,
      frameCount: rotation.length,
      dataBytes: rotation.length * 2,
      durationSeconds: rotation.length / audio.facts.sampleRate,
    },
  };
}

test("alignment slices both captures from their own audible onset", () => {
  const reference = tone(1);
  const delivered = hole(tone(2), 0, 0.5);
  const aligned = alignToReference(reference, delivered, "ref.wav", "del.wav");

  assert.equal(aligned.reference.audio.facts.frameCount, aligned.delivered.audio.facts.frameCount);
  assert.ok(aligned.reference.audio.facts.frameCount > 20_000);
});

test("a truncated delivered line is refused, never measured short", () => {
  const reference = tone(1);
  const delivered = tone(0.3);
  assert.throws(
    () => alignToReference(reference, delivered, "ref.wav", "del.wav"),
    (error: unknown) =>
      error instanceof TimbreComparisonError && error.code === "truncated",
  );
});

test("a copy delivered a few milliseconds late measures as a copy, not as distortion", () => {
  const committed = loadVoiceReference();
  const late = delayed(copyWithNoise(committed.audio), 5);
  const comparison = compareTimbre(committed.audio, committed.path, late, "delivered-late.wav");

  assert.ok(
    comparison.distortionDb <= -45,
    `a 5 ms lead-in on a copy measured ${comparison.distortionDb.toFixed(2)} dB residual`,
  );
});

test("a fresh rendering of the same line is unmeasured, not a fabricated residual", () => {
  const committed = loadVoiceReference();
  const again = reRendered(copyWithNoise(committed.audio));

  assert.throws(
    () => compareTimbre(committed.audio, committed.path, again, "delivered-again.wav"),
    (error: unknown) =>
      error instanceof TimbreComparisonError &&
      error.code === "unmeasured" &&
      /correlation/.test(error.message) &&
      /independent rendering/.test(error.message),
  );
});

test("a clean delivered copy measures every timbre axis", () => {
  const { committed, deliveredAudio, deliveredPath } = referencePair();
  const comparison = compareTimbre(committed.audio, committed.path, deliveredAudio, deliveredPath);

  assert.ok(Math.abs(comparison.levelDeltaLu) < 0.2);
  assert.ok(comparison.truePeakDbtp <= -1);
  assert.ok(comparison.distortionDb <= -45);
  assert.ok(comparison.crest >= 1.2);
  assert.ok(comparison.bandDeltaDb <= 3);
  assert.equal(comparison.breakups, 0);
  assert.equal(comparison.breakupMatchSeconds, 0.05);
});

test("a near-full-scale delivered copy fails the true-peak axis", () => {
  const { committed, deliveredAudio } = referencePair();
  const loud = {
    samples: Int16Array.from(deliveredAudio.samples, (sample) =>
      Math.max(-32768, Math.min(32767, Math.round(sample * 8))),
    ),
    facts: { ...deliveredAudio.facts },
  };
  // An 8x copy is still one recording, but its amplified noise floor moves the
  // onset frame, so the axis is read where it lives: on the delivered file.
  const peak = axisOf(committed.audio, loud, "truePeak");
  assert.equal(peak.verdict, "fail");
  assert.ok((peak.value ?? -Infinity) > -1);
});

test("a reshaped delivered copy fails the distortion axis", () => {
  const { committed, deliveredAudio, deliveredPath } = referencePair();
  const shaped = new Int16Array(deliveredAudio.samples.length);
  for (let index = 0; index < shaped.length; index += 1) {
    const base = deliveredAudio.samples[index]! / 32768;
    const harmonic = 0.01 * Math.sin((2 * Math.PI * 660 * index) / deliveredAudio.facts.sampleRate);
    shaped[index] = Math.round(Math.max(-1, Math.min(1, base + harmonic)) * 32767);
  }
  const comparison = compareTimbre(
    committed.audio,
    committed.path,
    { samples: shaped, facts: { ...deliveredAudio.facts } },
    deliveredPath,
  );
  assert.ok(comparison.distortionDb > -45);
});

test("a hole the reference does not have fails the breakup axis", () => {
  const { committed, deliveredAudio, deliveredPath } = referencePair();
  const holed = hole(deliveredAudio, 1, 1.05);
  const comparison = compareTimbre(committed.audio, committed.path, holed, deliveredPath);
  assert.ok(comparison.breakups > 0);
});

test("a spectral change fails the band-delta axis", () => {
  const { committed, deliveredAudio } = referencePair();
  // A copy heard through a low-pass: still the same recording (so the shape
  // axes stay comparable), with its high band removed.
  const smoothed = new Int16Array(deliveredAudio.samples.length);
  const taps = 12;
  let running = 0;
  for (let index = 0; index < deliveredAudio.samples.length; index += 1) {
    running += deliveredAudio.samples[index]!;
    if (index >= taps) running -= deliveredAudio.samples[index - taps]!;
    smoothed[index] = Math.round(running / Math.min(index + 1, taps));
  }
  const band = axisOf(committed.audio, { samples: smoothed, facts: { ...deliveredAudio.facts } }, "spectralBalance");
  assert.equal(band.verdict, "fail");
  assert.ok((band.value ?? 0) > 3);
});

test("a squared-off delivered copy fails the crest axis", () => {
  const { committed, deliveredAudio } = referencePair();
  const square = new Int16Array(deliveredAudio.samples.length);
  for (let index = 0; index < square.length; index += 1) {
    square[index] = deliveredAudio.samples[index]! >= 0 ? 20_000 : -20_000;
  }
  // Squaring the lead-in noise turns it into loud buzz, so this pair is not
  // onset-comparable; the crest axis is read on the delivered file alone.
  const crest = axisOf(committed.audio, { samples: square, facts: { ...deliveredAudio.facts } }, "crest");
  assert.equal(crest.verdict, "fail");
  assert.ok((crest.value ?? Infinity) < 1.2);
});

test("a long fade is measured from the delivered capture", () => {
  const { committed, deliveredAudio, deliveredPath } = referencePair();
  const faded = fade(deliveredAudio, 2, 200);
  const comparison = compareTimbre(committed.audio, committed.path, faded, deliveredPath);
  // The fade is A7's business, not a timbre axis; the comparison still measures
  // every axis from the same aligned pair.
  assert.ok(Number.isFinite(comparison.levelDeltaLu));
  assert.ok(comparison.levelDeltaLu < 0, "the fade removed energy from the delivered line");
});
