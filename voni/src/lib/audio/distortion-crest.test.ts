/**
 * Distortion residual and crest factor are the two metrics that make a
 * reshaped or squared-off voice visible as a number: a delivered file is
 * compared against the reference rendering of the same line, and a clean copy
 * must report no residual at all.
 *
 * Fixtures are built straight from the `DecodedAudio` seam (`facts` plus
 * interleaved `samples`) so the analyser is measured on what a saved file
 * yields, with no second decoder to disagree with.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AudioFacts, DecodedAudio } from "./format-facts";
import { DistortionCrestError, measureDistortionAndCrest } from "./distortion-crest";

/** A sine at `frequency` Hz, `amplitude` full scale, over `frames` samples. */
function tone(frequency: number, amplitude: number, frames: number, rate = 24_000): Float64Array {
  const out = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    out[frame] = amplitude * Math.sin((2 * Math.PI * frequency * frame) / rate);
  }
  return out;
}

/** Wrap full-scale floats as 16-bit PCM, the only sample format the seam yields. */
function toPcm(samples: Float64Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32_768, Math.min(32_767, Math.round(samples[i] * 32_767)));
  }
  return out;
}

function decoded(
  samples: ArrayLike<number>,
  { sampleRate = 24_000, channels = 1 }: { sampleRate?: number; channels?: number } = {},
): DecodedAudio {
  const pcm = Int16Array.from(samples);
  const frameCount = pcm.length / channels;
  const facts: AudioFacts = {
    container: "pcm",
    sampleRate,
    channels,
    bitsPerSample: 16,
    byteRate: sampleRate * channels * 2,
    dataBytes: pcm.length * 2,
    frameCount,
    durationSeconds: frameCount / sampleRate,
  };
  return { facts, samples: pcm };
}

function check(report: ReturnType<typeof measureDistortionAndCrest>, metric: string) {
  const found = report.checks.find((entry) => entry.metric === metric);
  assert.ok(found, `report has a ${metric} check`);
  return found;
}

test("a clean copy of the reference reports no residual", () => {
  const reference = decoded(toPcm(tone(1000, 0.5, 12_000)));
  const delivered = decoded(toPcm(tone(1000, 0.5, 12_000)));

  const report = measureDistortionAndCrest(reference, delivered);

  assert.equal(report.distortion.residualRms, 0);
  assert.equal(report.distortion.residualDb, -Infinity);
  assert.equal(check(report, "distortion-residual").verdict, "pass");
  assert.equal(report.verdict, "pass");
});

test("a known third-harmonic residual is reported at its true level and fails", () => {
  const reference = toPcm(tone(1000, 0.5, 12_000));
  const delivered = new Float64Array(reference.length);
  // 1% third harmonic: -40 dB relative to the fundamental.
  for (let frame = 0; frame < reference.length; frame++) {
    delivered[frame] =
      reference[frame] / 32_767 +
      0.01 * 0.5 * Math.sin((2 * Math.PI * 3000 * frame) / 24_000);
  }

  const report = measureDistortionAndCrest(decoded(reference), decoded(toPcm(delivered)));

  assert.ok(
    Math.abs(report.distortion.residualDb - -40) < 0.2,
    `third harmonic reads ${report.distortion.residualDb.toFixed(2)} dB`,
  );
  const distortion = check(report, "distortion-residual");
  assert.equal(distortion.verdict, "fail");
  assert.equal(distortion.measured, report.distortion.residualDb);
  assert.match(distortion.detail, /-40\.0 dB/);
  assert.equal(report.verdict, "fail");
  assert.deepEqual(
    report.failures.map((entry) => entry.metric),
    ["distortion-residual"],
  );
});

test("crest factor separates clean speech-like audio from a squared-off copy", () => {
  const frames = 12_000;
  const partials: Array<[number, number]> = [
    [220, 0.3],
    [330, 0.2],
    [550, 0.15],
    [880, 0.1],
  ];
  const speech = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    for (const [frequency, amplitude] of partials) {
      speech[frame] +=
        amplitude * Math.sin((2 * Math.PI * frequency * frame) / 24_000 + frequency / 1000);
    }
  }
  const clean = decoded(toPcm(speech));
  const squared = decoded(toPcm(Float64Array.from(speech, Math.sign)));

  const cleanReport = measureDistortionAndCrest(clean, clean);
  const squaredReport = measureDistortionAndCrest(squared, squared);

  // A square wave is peak 1 over RMS 1 by definition; this speech-like partials
  // mix peaks at roughly 1.9 times its RMS.
  assert.equal(squaredReport.crest.crestFactor, 1);
  assert.ok(
    cleanReport.crest.crestFactor > 1.5,
    `clean speech-like crest is ${cleanReport.crest.crestFactor.toFixed(3)}`,
  );
  assert.equal(check(cleanReport, "crest-factor").verdict, "pass");
  assert.equal(check(squaredReport, "crest-factor").verdict, "fail");
  assert.equal(squaredReport.verdict, "fail");
  assert.deepEqual(
    squaredReport.failures.map((entry) => entry.metric),
    ["crest-factor"],
  );
});

test("a failure names the metric that failed, not just that the file was bad", () => {
  const frames = 6000;
  const speech = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    speech[frame] =
      0.4 * Math.sin((2 * Math.PI * 220 * frame) / 24_000) +
      0.2 * Math.sin((2 * Math.PI * 550 * frame) / 24_000);
  }
  const squared = toPcm(Float64Array.from(speech, Math.sign));

  const crestOnly = measureDistortionAndCrest(decoded(squared), decoded(squared));
  assert.match(crestOnly.summary, /^FAIL crest-factor:/);
  assert.doesNotMatch(crestOnly.summary, /distortion-residual/);

  const reference = toPcm(tone(1000, 0.5, frames));
  const withHarmonic = Float64Array.from(
    reference,
    (value, frame) =>
      value / 32_767 + 0.01 * 0.5 * Math.sin((2 * Math.PI * 3000 * frame) / 24_000),
  );
  const distortionOnly = measureDistortionAndCrest(decoded(reference), decoded(toPcm(withHarmonic)));
  assert.match(distortionOnly.summary, /^FAIL distortion-residual:/);
  assert.doesNotMatch(distortionOnly.summary, /crest-factor/);
});

test("a delivered file at another rate or channel count is refused by name, never compared", () => {
  const reference = decoded(toPcm(tone(1000, 0.5, 2400)), { sampleRate: 24_000, channels: 1 });

  assert.throws(
    () =>
      measureDistortionAndCrest(
        reference,
        decoded(toPcm(tone(1000, 0.5, 4800)), { sampleRate: 48_000, channels: 1 }),
      ),
    (error: unknown) =>
      error instanceof DistortionCrestError &&
      error.code === "format-mismatch" &&
      /24.?000 Hz/.test(error.message),
  );
  assert.throws(
    () =>
      measureDistortionAndCrest(
        reference,
        decoded(new Int16Array(4800), { sampleRate: 24_000, channels: 2 }),
      ),
    (error: unknown) => error instanceof DistortionCrestError && error.code === "format-mismatch",
  );
});

test("a silent reference is INFO, never PASS", () => {
  const silent = decoded(new Int16Array(4800));

  const report = measureDistortionAndCrest(silent, silent);

  assert.equal(check(report, "distortion-residual").measured, null);
  assert.equal(check(report, "distortion-residual").verdict, "info");
  assert.equal(check(report, "crest-factor").measured, null);
  assert.equal(check(report, "crest-factor").verdict, "info");
  assert.equal(report.verdict, "info");
  assert.deepEqual(report.failures, []);
  assert.match(report.summary, /^INFO /);
  assert.doesNotMatch(report.summary, /^PASS/);
});

test("a silent delivery where the reference speaks is a measured failure", () => {
  const reference = decoded(toPcm(tone(1000, 0.5, 4800)));

  const report = measureDistortionAndCrest(reference, decoded(new Int16Array(4800)));

  assert.equal(report.distortion.residualDb, Infinity);
  assert.equal(check(report, "distortion-residual").verdict, "fail");
  assert.equal(report.verdict, "fail");
});

test("interleaved channels are measured separately at their worst channel", () => {
  const frames = 4800;
  const fundamental = tone(1000, 0.5, frames);
  const clean = new Float64Array(frames * 2);
  const reshaped = new Float64Array(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    clean[frame * 2] = fundamental[frame];
    clean[frame * 2 + 1] = fundamental[frame];
    reshaped[frame * 2] = fundamental[frame]; // left stays clean
    reshaped[frame * 2 + 1] =
      fundamental[frame] + 0.01 * 0.5 * Math.sin((2 * Math.PI * 3000 * frame) / 24_000);
  }

  const residual = measureDistortionAndCrest(
    decoded(toPcm(clean), { channels: 2 }),
    decoded(toPcm(reshaped), { channels: 2 }),
  ).distortion;

  assert.equal(residual.worstChannel, 1);
  assert.equal(residual.channelResidualsDb.length, 2);
  assert.equal(residual.channelResidualsDb[0], -Infinity);
  assert.ok(Math.abs(residual.channelResidualsDb[1] - -40) < 0.2);
});

test("a level change alone is not distortion: gain is fitted before the residual", () => {
  const reference = decoded(toPcm(tone(1000, 0.2, 4800)));

  // A gain change re-quantises, so the residual is 16-bit noise (~-78 dB), not
  // a shape difference; it must stay far below the -60 dB bar.
  for (const amplitude of [0.1, 0.4]) {
    const report = measureDistortionAndCrest(reference, decoded(toPcm(tone(1000, amplitude, 4800))));
    assert.ok(
      report.distortion.residualDb < -70,
      `${amplitude} gain reads ${report.distortion.residualDb.toFixed(1)} dB`,
    );
    assert.equal(check(report, "distortion-residual").verdict, "pass");
  }
});

test("a delivery that stops early leaves a residual rather than a shorter comparison", () => {
  const reference = toPcm(tone(1000, 0.5, 4800));
  const cut = Int16Array.from(reference);
  cut.fill(0, 4000);

  const residual = measureDistortionAndCrest(decoded(reference), decoded(cut)).distortion;

  assert.equal(residual.missingFrames, 0);
  assert.ok(residual.residualDb > -60, `truncated delivery reads ${residual.residualDb.toFixed(1)} dB`);

  const shortened = measureDistortionAndCrest(
    decoded(reference),
    decoded(reference.subarray(0, 4000)),
  ).distortion;
  assert.equal(shortened.missingFrames, 800);
  assert.ok(shortened.residualDb > -60);
});
