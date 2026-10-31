import test from "node:test";
import assert from "node:assert/strict";

import type { DecodedAudio } from "@/lib/audio/format-facts";
import { loadVoiceReference } from "@/lib/audio/voice-reference";

import { alignToReference, compareTimbre, TimbreComparisonError } from "./compare";
import { fade, hole, tone, writeWav } from "./test-pcm";

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
  const { committed, deliveredAudio, deliveredPath } = referencePair();
  const loud = {
    samples: Int16Array.from(deliveredAudio.samples, (sample) =>
      Math.max(-32768, Math.min(32767, Math.round(sample * 8))),
    ),
    facts: { ...deliveredAudio.facts },
  };
  const comparison = compareTimbre(committed.audio, committed.path, loud, deliveredPath);
  assert.ok(comparison.truePeakDbtp > -1);
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
  const { committed, deliveredAudio, deliveredPath } = referencePair();
  const low = tone(committed.audio.facts.durationSeconds, { frequency: 90, amplitude: 0.2 });
  const comparison = compareTimbre(
    committed.audio,
    committed.path,
    { samples: low.samples, facts: { ...deliveredAudio.facts } },
    deliveredPath,
  );
  assert.ok(comparison.bandDeltaDb > 3);
});

test("a squared-off delivered copy fails the crest axis", () => {
  const { committed, deliveredAudio, deliveredPath } = referencePair();
  const square = new Int16Array(deliveredAudio.samples.length);
  for (let index = 0; index < square.length; index += 1) {
    square[index] = deliveredAudio.samples[index]! >= 0 ? 20_000 : -20_000;
  }
  const comparison = compareTimbre(
    committed.audio,
    committed.path,
    { samples: square, facts: { ...deliveredAudio.facts } },
    deliveredPath,
  );
  assert.ok(comparison.crest < 1.2);
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
