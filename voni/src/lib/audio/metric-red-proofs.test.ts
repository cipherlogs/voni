/**
 * Every audio metric is proved able to fail (ticket 125).
 *
 * Each proof is a committed test, not a manual observation. The metric is
 * driven with a synthetic worst case whose expected behaviour comes from the
 * signal — a level step, a third-harmonic residual, a crest collapse, an octave
 * tilt, an inserted silence, a chunk-rate modulation, a true peak at the
 * ceiling, a folded band and a boundary fade — and the gate check for that
 * metric must read `FAIL`.
 *
 * Deleting the metric's check makes its proof fail twice over: the check lookup
 * finds nothing, and the registry test below notices a metric without a proof
 * (or a proof without a metric). A metric that cannot be made to fail does not
 * ship.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decodeWav, type DecodedAudio } from "./format-facts";
import {
  compareReferenceAndDelivered,
  type TwoCaptureComparison,
} from "./comparison";
import {
  W0_AUDIO_METRICS,
  evaluateW0Checks,
  type W0Check,
  type W0Metric,
} from "./w0-verdict";

const SAMPLE_RATE = 24_000;
const FULL_SCALE = 32_767;

function wavFrom(samples: number[]): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  samples.forEach((value, index) => {
    const scaled = Math.max(-1, Math.min(1, value)) * FULL_SCALE;
    out.writeInt16LE(Math.round(scaled), 44 + index * 2);
  });
  return out;
}

function tone(seconds: number, hz: number, amplitude: number): number[] {
  return Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_unused, index) =>
    amplitude * Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE),
  );
}

function silence(seconds: number): number[] {
  return new Array<number>(Math.round(seconds * SAMPLE_RATE)).fill(0);
}

function decoded(bytes: Buffer): DecodedAudio {
  return decodeWav(bytes);
}

const GREETING = {
  kind: "greeting" as const,
  text: "Hi, I'm Voni! Let's try something cool.",
};

function checksFor(reference: Buffer, delivered: Buffer): W0Check[] {
  const comparison: TwoCaptureComparison = compareReferenceAndDelivered({
    reference: { path: "/captures/reference.wav", audio: decoded(reference) },
    delivered: { path: "/captures/delivered.wav", audio: decoded(delivered) },
    line: GREETING,
  });
  return evaluateW0Checks({ comparison, transcript: GREETING.text });
}

function metricCheck(checks: readonly W0Check[], metric: W0Metric): W0Check {
  const found = checks.find(
    (entry) => entry.metric === metric && (entry.layer === "our pipeline" || entry.layer === "client"),
  );
  assert.ok(found, `the rule evaluated a ${metric} check; a missing metric has no proof to fail`);
  return found;
}

/** Speak, hold digitally silent, speak again: the hole a starved buffer leaves. */
function toneWithHole(): number[] {
  return [
    ...tone(0.4, 180, 0.35),
    ...silence(0.5),
    ...tone(0.4, 180, 0.35),
    ...tone(0.4, 180, 0.35),
  ];
}

function faded(samples: number[], atSeconds = 0.5, depthDb = -6, fadeSeconds = 0.06): number[] {
  const start = Math.round(atSeconds * SAMPLE_RATE);
  const length = Math.round(fadeSeconds * SAMPLE_RATE);
  const floor = 10 ** (depthDb / 20);
  return samples.map((sample, index) => {
    if (index < start || index >= start + length) return sample;
    const position = (index - start) / length;
    return sample * (1 - (1 - floor) * Math.sin(Math.PI * position));
  });
}

type Proof = { reference: number[]; delivered: number[]; applicant: string };

/**
 * One synthetic worst case per metric. Each is built independently of the
 * analyser under test: the shape is the input, the expectation is the signal.
 */
const PROOFS: Record<W0Metric, () => Proof> = {
  level: () => ({
    reference: tone(1, 1_000, 0.4),
    delivered: tone(1, 1_000, 0.2),
    applicant: "a 6.02 dB level step",
  }),
  peak: () => ({
    reference: tone(1, 500, 0.4),
    delivered: tone(1, 500, 1),
    applicant: "a delivered true peak at the full-scale ceiling",
  }),
  spectrum: () => ({
    reference: tone(1, 500, 0.3).map(
      (sample, index) => sample + 0.3 * Math.sin((2 * Math.PI * 4_000 * index) / SAMPLE_RATE),
    ),
    delivered: tone(1, 500, 0.44).map(
      (sample, index) => sample + 0.16 * Math.sin((2 * Math.PI * 4_000 * index) / SAMPLE_RATE),
    ),
    applicant: "an 8.8 dB octave tilt",
  }),
  distortion: () => {
    const clean = tone(1, 440, 0.3);
    return {
      reference: clean,
      delivered: clean.map(
        (sample, index) =>
          sample + 0.01 * 0.3 * Math.sin((2 * Math.PI * 3 * 440 * index) / SAMPLE_RATE),
      ),
      applicant: "a 1% third-harmonic residual",
    };
  },
  crest: () => ({
    // Equal RMS, so only the shape changes: a square collapses the crest to 1.
    reference: tone(1, 500, 0.4),
    delivered: tone(1, 500, 0.4).map((sample) => (sample >= 0 ? 0.283 : -0.283)),
    applicant: "a crest collapse",
  }),
  modulation: () => {
    const steady = tone(2, 1_000, 0.4);
    return {
      reference: steady,
      delivered: steady.map(
        (sample, index) => sample * (1 + 0.5 * Math.sin((2 * Math.PI * 20 * index) / SAMPLE_RATE)),
      ),
      applicant: "a 20 Hz, 50% chunk-rate modulation",
    };
  },
  breakups: () => ({
    reference: tone(1.7, 180, 0.35),
    delivered: toneWithHole(),
    applicant: "an inserted 0.5 s silence",
  }),
  alias: () => ({
    // 11 kHz survives a 24 kHz capture; a 16 kHz device folds it to 5 kHz.
    reference: tone(1, 11_000, 0.4),
    delivered: tone(1, 5_000, 0.4),
    applicant: "a device-rate alias (11 kHz folded to 5 kHz)",
  }),
  fade: () => ({
    reference: tone(1, 1_000, 0.4),
    delivered: faded(tone(1, 1_000, 0.4)),
    applicant: "a 60 ms boundary fade",
  }),
};

test("every audio metric has a committed red proof and no proof is orphaned", () => {
  assert.deepEqual(
    Object.keys(PROOFS).sort(),
    [...W0_AUDIO_METRICS].sort(),
    "the proof map and the metric registry move together",
  );
  assert.deepEqual(
    [...W0_AUDIO_METRICS],
    ["level", "peak", "spectrum", "distortion", "crest", "modulation", "breakups", "alias", "fade"],
    "no metric can be removed from the registry to skip its proof",
  );
});

for (const metric of W0_AUDIO_METRICS) {
  test(`the ${metric} metric fails on its synthetic worst case`, () => {
    const proof = PROOFS[metric]();
    const check = metricCheck(
      checksFor(wavFrom(proof.reference), wavFrom(proof.delivered)),
      metric,
    );

    assert.equal(
      check.status,
      "FAIL",
      `${proof.applicant} must make ${metric} red, got ${check.status}: ${check.reason}`,
    );
    assert.ok(check.reason !== null && check.reason.length > 0, `${metric} names its failure`);
    assert.match(
      String(check.producer),
      /^[a-z-]+\.[a-zA-Z]+$/,
      `${metric} names the module that measured it; a value with no producer is not evidence`,
    );
  });
}

test("a clean copy is not red on any audio metric", () => {
  // The control: if every proof passed on the clean pair too, none of the red
  // proofs above would prove the metric can fail.
  const clean = wavFrom(tone(1, 500, 0.4));
  const checks = checksFor(clean, clean);
  for (const metric of W0_AUDIO_METRICS) {
    const check = metricCheck(checks, metric);
    assert.equal(check.status, "PASS", `${metric} on a clean copy: ${check.reason}`);
  }
});

test("a crest collapse is a distinct check from the residual it rides on", () => {
  // A square wave also reshapes the spectrum; the point of the proof is that
  // the crest check reads the collapse itself, not the residual.
  const proof = PROOFS.crest();
  const checks = checksFor(wavFrom(proof.reference), wavFrom(proof.delivered));
  const crest = metricCheck(checks, "crest");
  assert.equal(crest.status, "FAIL");
  assert.equal(crest.value !== null && crest.value < 1.2, true, `crest ${crest.value}`);
  assert.equal(crest.bar?.key, "timbreMeasuredCrestMin");
});
