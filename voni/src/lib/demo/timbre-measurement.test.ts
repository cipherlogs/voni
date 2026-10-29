/**
 * W5 parity proof (voice-parity ticket 74): the timbre gate's measured result.
 *
 * The gate may only PASS on six measured axes — level against the measured
 * reference, true peak, distortion residual, crest factor, spectral balance and
 * breakups — computed from the delivered capture and the reference rendering of
 * the same line. A missing capture is unmeasured, never a PASS.
 *
 * Every axis is proved twice: a clean copy passes it, and a synthetic worst
 * case the metric is meant to catch fails it. A metric that cannot be made to
 * fail on a worst case does not ship.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodePcm } from "@/lib/audio/format-facts";
import {
  MEASURED_TIMBRE_AXES,
  measureTimbre,
  type MeasuredTimbreAxisResult,
} from "./timbre-measurement";

const SAMPLE_RATE = 24_000;
const FRAMES = SAMPLE_RATE;

/** A sine at `frequency` Hz, `amplitude` full scale, in 16-bit PCM. */
function tone(frequency = 1000, amplitude = 0.1, frames = FRAMES, rate = SAMPLE_RATE): Int16Array {
  const out = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const value = amplitude * Math.sin((2 * Math.PI * frequency * frame) / rate);
    out[frame] = Math.max(-32_768, Math.min(32_767, Math.round(value * 32_767)));
  }
  return out;
}

function capture(path: string, samples: Int16Array, rate = SAMPLE_RATE) {
  return {
    path,
    audio: decodePcm(new Uint8Array(samples.buffer.slice(0)), { sampleRate: rate, channels: 1 }),
  };
}

function axis(result: ReturnType<typeof measureTimbre>, name: string): MeasuredTimbreAxisResult {
  const found = result.axes.find((entry) => entry.axis === name);
  assert.ok(found, `result names the ${name} axis`);
  return found;
}

const reference = () => capture("captures/reference-anna-en.wav", tone());

/**
 * A real delivery: its own file, carrying the same voice with the one-sample
 * drift any capture chain leaves behind. The reference itself is not a
 * delivery, so it cannot stand in for this file (ticket 144).
 */
function cleanDelivery() {
  const samples = tone();
  samples[samples.length - 1] = samples[samples.length - 1]! + 1;
  return capture("captures/delivered-anna-en.wav", samples);
}

test("a clean copy passes all six measured axes and names every one", () => {
  const result = measureTimbre({ reference: reference(), delivered: cleanDelivery() });
  assert.equal(result.status, "PASS", result.detail);
  for (const name of MEASURED_TIMBRE_AXES) {
    const leg = axis(result, name);
    assert.equal(leg.verdict, "pass", `${name} must pass on a clean copy: ${leg.detail}`);
  }
  assert.match(result.detail, /level/);
  assert.match(result.detail, /true peak/i);
  assert.match(result.detail, /distortion/i);
  assert.match(result.detail, /crest/i);
  assert.match(result.detail, /spectral/i);
  assert.match(result.detail, /breakup/i);
  assert.equal(result.referenceFile, "captures/reference-anna-en.wav");
  assert.equal(result.deliveredFile, "captures/delivered-anna-en.wav");
  assert.deepEqual(result.refusals, []);
});

test("no measured result is INFO/unmeasured, never a PASS", () => {
  const absent = measureTimbre(null);
  assert.equal(absent.status, "INFO");
  for (const leg of absent.axes) assert.equal(leg.verdict, "unmeasured", leg.axis);

  const half = measureTimbre({ reference: reference(), delivered: null });
  assert.equal(half.status, "INFO", "a reference with no delivery is unmeasured");
  assert.match(half.detail, /delivered/i);
});

test("a level step away from the measured reference fails the level axis", () => {
  const quiet = capture("captures/delivered-anna-en.wav", tone(1000, 0.05));
  const result = measureTimbre({ reference: reference(), delivered: quiet });
  assert.equal(result.status, "FAIL", result.detail);
  const level = axis(result, "level");
  assert.equal(level.verdict, "fail", level.detail);
  assert.match(level.detail, /level differs|level agrees/i);
});

test("a full-scale sample fails the true-peak axis", () => {
  const spiked = tone();
  spiked[Math.floor(spiked.length / 2)] = 32_767;
  const result = measureTimbre({
    reference: reference(),
    delivered: capture("captures/delivered-anna-en.wav", spiked),
  });
  const peak = axis(result, "truePeak");
  assert.equal(peak.verdict, "fail", peak.detail);
  assert.match(peak.detail, /true peak/i);
});

test("a known third-harmonic residual fails the distortion axis", () => {
  const fundamental = tone();
  const delivered = new Int16Array(fundamental.length);
  for (let frame = 0; frame < fundamental.length; frame++) {
    const second = 0.01 * Math.sin((2 * Math.PI * 3000 * frame) / SAMPLE_RATE);
    delivered[frame] = Math.max(
      -32_768,
      Math.min(32_767, Math.round((fundamental[frame] / 32_767 + second) * 32_767)),
    );
  }
  const result = measureTimbre({
    reference: reference(),
    delivered: capture("captures/delivered-anna-en.wav", delivered),
  });
  const distortion = axis(result, "distortion");
  assert.equal(distortion.verdict, "fail", distortion.detail);
  assert.match(distortion.detail, /distortion/i);
});

test("a squared-off waveform fails the crest axis", () => {
  const square = new Int16Array(FRAMES);
  for (let frame = 0; frame < FRAMES; frame++) {
    square[frame] = Math.sin((2 * Math.PI * 1000 * frame) / SAMPLE_RATE) >= 0 ? 3_277 : -3_277;
  }
  const result = measureTimbre({
    reference: reference(),
    delivered: capture("captures/delivered-anna-en.wav", square),
  });
  const crest = axis(result, "crest");
  assert.equal(crest.verdict, "fail", crest.detail);
  assert.match(crest.detail, /crest/i);
});

test("a boosted octave band fails the spectral-balance axis", () => {
  const twoTone = (high: number) => {
    const samples = new Int16Array(FRAMES);
    for (let frame = 0; frame < FRAMES; frame++) {
      const value =
        0.2 * Math.sin((2 * Math.PI * 500 * frame) / SAMPLE_RATE) +
        high * Math.sin((2 * Math.PI * 4000 * frame) / SAMPLE_RATE);
      samples[frame] = Math.max(-32_768, Math.min(32_767, Math.round(value * 32_767)));
    }
    return samples;
  };
  const result = measureTimbre({
    reference: capture("captures/reference-anna-en.wav", twoTone(0.2)),
    delivered: capture("captures/delivered-anna-en.wav", twoTone(0.6)),
  });
  const spectral = axis(result, "spectralBalance");
  assert.equal(spectral.verdict, "fail", spectral.detail);
  assert.match(spectral.detail, /band/i);
});

test("an inserted silence the reference does not have fails the breakups axis", () => {
  const holed = tone();
  const start = Math.floor(holed.length / 2);
  const end = start + Math.round(0.1 * SAMPLE_RATE);
  for (let frame = start; frame < end; frame++) holed[frame] = 0;
  const result = measureTimbre({
    reference: reference(),
    delivered: capture("captures/delivered-anna-en.wav", holed),
  });
  const breakups = axis(result, "breakups");
  assert.equal(breakups.verdict, "fail", breakups.detail);
  assert.match(breakups.detail, /breakup|inserted silence/i);
});

test("the measured result is deterministic: the same files yield the same verdict", () => {
  const a = measureTimbre({ reference: reference(), delivered: cleanDelivery() });
  const b = measureTimbre({ reference: reference(), delivered: cleanDelivery() });
  assert.deepEqual(a, b);
  assert.equal(a.status, "PASS", a.detail);
});
