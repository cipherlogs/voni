/**
 * Envelope modulation is the metric that makes a robotic, phased texture a
 * number: a steady tone must read flat, and a tone whose amplitude swings at a
 * known rate must report that rate in hertz and that depth as a ratio.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { DecodedAudio } from "./format-facts";
import { measureEnvelopeModulation } from "./envelope-modulation";

const DEFAULT_RATE = 24_000;
const DEFAULT_CARRIER_HZ = 440;

type ToneOptions = {
  seconds: number;
  sampleRate?: number;
  channels?: number;
  carrierHz?: number;
  amplitude?: number;
  /** Periodic amplitude modulation, separate from the carrier. */
  modulationHz?: number;
  /** Peak-to-trough swing as a fraction of the mean amplitude. */
  depth?: number;
};

/** Build a decoded tone; the analyser only ever sees `facts` and `samples`. */
function decodedTone({
  seconds,
  sampleRate = DEFAULT_RATE,
  channels = 1,
  carrierHz = DEFAULT_CARRIER_HZ,
  amplitude = 0.5,
  modulationHz = 0,
  depth = 0,
}: ToneOptions): DecodedAudio {
  const frameCount = Math.round(seconds * sampleRate);
  const samples = new Int16Array(frameCount * channels);
  for (let frame = 0; frame < frameCount; frame++) {
    const t = frame / sampleRate;
    const gain = modulationHz > 0 ? 1 + depth * Math.cos(2 * Math.PI * modulationHz * t) : 1;
    const value = amplitude * gain * Math.sin(2 * Math.PI * carrierHz * t);
    for (let channel = 0; channel < channels; channel++) {
      samples[frame * channels + channel] = Math.round(value * 32767);
    }
  }
  return {
    facts: {
      container: "wav",
      sampleRate,
      channels,
      bitsPerSample: 16,
      byteRate: sampleRate * channels * 2,
      dataBytes: samples.length * 2,
      frameCount,
      durationSeconds: frameCount / sampleRate,
    },
    samples,
  };
}

/** Apply a per-chunk gain, the shape a playout buffer-length envelope leaves behind. */
function withChunkGain(
  audio: DecodedAudio,
  chunkSeconds: number,
  gainAt: (phase: number) => number,
): DecodedAudio {
  const { sampleRate, channels, frameCount } = audio.facts;
  const chunkFrames = Math.max(1, Math.round(chunkSeconds * sampleRate));
  const samples = new Int16Array(audio.samples.length);
  for (let frame = 0; frame < frameCount; frame++) {
    const gain = gainAt((frame % chunkFrames) / chunkFrames);
    for (let channel = 0; channel < channels; channel++) {
      samples[frame * channels + channel] = Math.round(
        audio.samples[frame * channels + channel] * gain,
      );
    }
  }
  return { facts: { ...audio.facts }, samples };
}

test("a steady tone reports no modulation", () => {
  const reading = measureEnvelopeModulation(decodedTone({ seconds: 2 }));

  assert.equal(reading.rateHz, 0);
  assert.ok(reading.depth < 0.005, `depth ${reading.depth}`);
  assert.equal(reading.modulated, false);
});

test("a tone amplitude-modulated at a known rate reports that rate and depth", () => {
  const reading = measureEnvelopeModulation(
    decodedTone({ seconds: 3, modulationHz: 7, depth: 0.5 }),
  );

  assert.ok(Math.abs(reading.rateHz - 7) < 0.1, `rate ${reading.rateHz}`);
  assert.ok(Math.abs(reading.depth - 0.5) < 0.02, `depth ${reading.depth}`);
  // 20 log10((1 + 0.5) / (1 - 0.5)) = 9.54 dB.
  assert.ok(Math.abs(reading.depthDb - 9.54) < 0.2, `depthDb ${reading.depthDb}`);
  assert.equal(reading.modulated, true);
});

test("a chunk-rate modulated copy of a clean file fails the no-modulation threshold", () => {
  // The live playout buffers 10 ms chunks, so a buffer-length envelope shows up
  // as a 100 Hz swing — the artefact the owner hears as robotic and phased.
  const clean = decodedTone({ seconds: 2 });
  const chunked = withChunkGain(clean, 0.01, (phase) => 1 - 0.4 * phase);

  const before = measureEnvelopeModulation(clean);
  const after = measureEnvelopeModulation(chunked);

  assert.equal(before.modulated, false);
  assert.ok(Math.abs(after.rateHz - 100) < 2, `rate ${after.rateHz}`);
  assert.ok(after.depth >= 0.05, `depth ${after.depth}`);
  assert.equal(after.modulated, true);
});

test("the rate is in hertz and the depth is a ratio and decibels, consistently", () => {
  const slow = measureEnvelopeModulation(
    decodedTone({ seconds: 3, modulationHz: 5, depth: 0.3 }),
  );
  const fast = measureEnvelopeModulation(
    decodedTone({ seconds: 3, modulationHz: 10, depth: 0.3 }),
  );

  // Twice the modulation frequency is twice the hertz and half the period.
  assert.ok(Math.abs(fast.rateHz / slow.rateHz - 2) < 0.02, `${slow.rateHz} -> ${fast.rateHz}`);
  assert.ok(
    Math.abs(2 / fast.rateHz - 1 / slow.rateHz) < 0.002,
    `${1 / slow.rateHz}s -> ${1 / fast.rateHz}s`,
  );

  // The same depth at two rates must read the same, in both units.
  for (const reading of [slow, fast]) {
    assert.ok(Math.abs(reading.depth - 0.3) < 0.01, `depth ${reading.depth}`);
    const expected = 20 * Math.log10((1 + reading.depth) / (1 - reading.depth));
    assert.ok(Math.abs(reading.depthDb - expected) < 1e-9, `depthDb ${reading.depthDb}`);
  }
});

test("a band can isolate a chunk-rate artefact from a natural syllable swing", () => {
  // Speech swings deeply at its syllable rate; the artefact is a smaller,
  // faster swing riding on top of it, so the band is what makes it visible.
  const speech = decodedTone({ seconds: 3, modulationHz: 3, depth: 0.8 });
  const withChunk = withChunkGain(speech, 0.01, (phase) => 1 + 0.15 * Math.cos(2 * Math.PI * phase));

  const overall = measureEnvelopeModulation(withChunk);
  const artefact = measureEnvelopeModulation(withChunk, { minRateHz: 40 });

  assert.ok(Math.abs(overall.rateHz - 3) < 0.2, `overall rate ${overall.rateHz}`);
  assert.ok(Math.abs(artefact.rateHz - 100) < 2, `artefact rate ${artefact.rateHz}`);
  assert.ok(Math.abs(artefact.depth - 0.15) < 0.02, `artefact depth ${artefact.depth}`);
  assert.equal(artefact.modulated, true);
});

test("a stereo 48 kHz file is measured at its own rate and channel mix", () => {
  const reading = measureEnvelopeModulation(
    decodedTone({ seconds: 3, sampleRate: 48_000, channels: 2, modulationHz: 9, depth: 0.4 }),
  );

  assert.ok(Math.abs(reading.rateHz - 9) < 0.1, `rate ${reading.rateHz}`);
  assert.ok(Math.abs(reading.depth - 0.4) < 0.02, `depth ${reading.depth}`);
  assert.equal(reading.modulated, true);
});

test("silence reports no modulation rather than a divide-by-zero rate", () => {
  const reading = measureEnvelopeModulation(decodedTone({ seconds: 1, amplitude: 0 }));

  assert.deepEqual(reading, { rateHz: 0, depth: 0, depthDb: 0, modulated: false });
});
