/**
 * Level facts are the baseline every other audio claim is compared against:
 * how loud a recording is (gated integrated loudness and RMS) and how close
 * its loudest moment comes to full scale (true peak, including the peaks that
 * land between samples).
 *
 * Expected values below come from the standard, not from the code: EBU Tech
 * 3341's first conformance case is a 1 kHz sine at a known RMS, which must read
 * that same number in LUFS within ±0.1 LU. The true-peak cases use a tone at
 * one quarter of the sample rate, phase-shifted so every sample sits at
 * −3.01 dBFS while the waveform itself reaches full scale — a sample-maximum
 * meter reports −3.01 dBTP for a file whose true peak is 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodePcm, type DecodedAudio } from "./format-facts";
import {
  LEVEL_TOLERANCE_DB,
  TRUE_PEAK_TOLERANCE_DB,
  analyseLevel,
  compareLevels,
} from "./level-facts";

/** Raw 16-bit PCM, so the audits run on the same decode path a saved file uses. */
function pcm(
  sampleRate: number,
  frameCount: number,
  channels: number,
  sampleAt: (frame: number, channel: number) => number,
): DecodedAudio {
  const bytes = Buffer.alloc(frameCount * channels * 2);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.max(-32768, Math.min(32767, Math.round(sampleAt(frame, channel))));
      bytes.writeInt16LE(value, (frame * channels + channel) * 2);
    }
  }
  return decodePcm(bytes, { sampleRate, channels });
}

/** A sine whose RMS is the stated dBFS, the way a level is usually quoted. */
function sineAtRms(sampleRate: number, hertz: number, rmsDbfs: number) {
  const amplitude = 32_768 * 10 ** (rmsDbfs / 20) * Math.SQRT2;
  return (frame: number) => amplitude * Math.sin((2 * Math.PI * hertz * frame) / sampleRate);
}

/** A sine whose waveform peak is the stated dBFS. */
function sineAtPeak(sampleRate: number, hertz: number, peakDbfs: number, phase = 0) {
  const amplitude = 32_768 * 10 ** (peakDbfs / 20);
  return (frame: number) => amplitude * Math.sin((2 * Math.PI * hertz * frame) / sampleRate + phase);
}

const near = (actual: number | null, expected: number, tolerance: number): boolean =>
  actual !== null && Math.abs(actual - expected) <= tolerance;

test("a 1 kHz tone at -20 dBFS RMS reports -20 LUFS and -20 dBFS RMS", () => {
  const facts = analyseLevel(pcm(24_000, 24_000, 1, sineAtRms(24_000, 1000, -20)));

  assert.equal(facts.measured, true);
  assert.equal(facts.absence, null);
  assert.ok(
    near(facts.integratedLufs, -20, LEVEL_TOLERANCE_DB),
    `integrated loudness ${facts.integratedLufs} should be -20 LUFS within ${LEVEL_TOLERANCE_DB} LU`,
  );
  assert.ok(
    near(facts.rmsDbfs, -20, LEVEL_TOLERANCE_DB),
    `RMS ${facts.rmsDbfs} should be -20 dBFS within ${LEVEL_TOLERANCE_DB} dB`,
  );
});

test("the same tone reports the same level at a third of the sample rate", () => {
  const at16k = analyseLevel(pcm(16_000, 16_000, 1, sineAtRms(16_000, 1000, -20)));

  assert.ok(
    near(at16k.integratedLufs, -20, LEVEL_TOLERANCE_DB),
    `16 kHz integrated loudness ${at16k.integratedLufs} should still be -20 LUFS`,
  );
});

test("a known -6 dB gain offset moves both readings by 6 dB", () => {
  const clean = analyseLevel(pcm(24_000, 24_000, 1, sineAtRms(24_000, 1000, -20)));
  const quieter = analyseLevel(pcm(24_000, 24_000, 1, sineAtRms(24_000, 1000, -26)));

  assert.ok(
    near(quieter.integratedLufs, -26, LEVEL_TOLERANCE_DB),
    `shifted integrated loudness ${quieter.integratedLufs} should be -26 LUFS`,
  );
  assert.ok(
    near(quieter.rmsDbfs, -26, LEVEL_TOLERANCE_DB),
    `shifted RMS ${quieter.rmsDbfs} should be -26 dBFS`,
  );
  const delta =
    clean.integratedLufs !== null && quieter.integratedLufs !== null
      ? quieter.integratedLufs - clean.integratedLufs
      : null;
  assert.ok(near(delta, -6, LEVEL_TOLERANCE_DB), `measured offset ${delta} should be -6 LU`);
});

test("true peak sees the inter-sample peak a sample maximum misses", () => {
  // Fs/4 at 45 degrees: every sample is ±0.707 of the waveform's own peak.
  const facts = analyseLevel(
    pcm(24_000, 24_000, 1, sineAtPeak(24_000, 6000, -6, Math.PI / 4)),
  );

  assert.ok(
    near(facts.samplePeakDbfs, -9.01, 0.05),
    `sample peak ${facts.samplePeakDbfs} should sit at -9.01 dBFS`,
  );
  assert.ok(
    near(facts.truePeakDbtp, -6, TRUE_PEAK_TOLERANCE_DB),
    `true peak ${facts.truePeakDbtp} should find the -6 dBTP waveform peak`,
  );
  assert.ok(
    facts.truePeakDbtp !== null &&
      facts.samplePeakDbfs !== null &&
      facts.truePeakDbtp - facts.samplePeakDbfs >= 2.9,
    "true peak must be more than the sample maximum when the peak is inter-sample",
  );
});

test("silence has no level at all, never a number that reads as a measurement", () => {
  const facts = analyseLevel(pcm(24_000, 24_000, 1, () => 0));

  assert.deepEqual(facts, {
    measured: false,
    absence: "digital-silence",
    integratedLufs: null,
    rmsDbfs: null,
    samplePeakDbfs: null,
    truePeakDbtp: null,
  });
});

test("a signal too quiet to pass the gate is absent rather than a tiny number", () => {
  const facts = analyseLevel(pcm(24_000, 24_000, 1, sineAtRms(24_000, 1000, -80)));

  assert.equal(facts.measured, false);
  assert.equal(facts.absence, "below-gate");
  assert.equal(facts.integratedLufs, null);
  assert.equal(facts.rmsDbfs, null);
  assert.equal(facts.truePeakDbtp, null);
});

test("a file shorter than one gating block is absent rather than invented", () => {
  const facts = analyseLevel(pcm(24_000, 4800, 1, sineAtRms(24_000, 1000, -20)));

  assert.equal(facts.measured, false);
  assert.equal(facts.absence, "too-short");
  assert.equal(facts.integratedLufs, null);
});

test("a quiet passage is gated out of integrated loudness but counted in RMS", () => {
  // Two seconds at -20 dBFS, then six seconds at -40 dBFS.
  const facts = analyseLevel(
    pcm(24_000, 192_000, 1, (frame) =>
      frame < 48_000
        ? sineAtRms(24_000, 1000, -20)(frame)
        : sineAtRms(24_000, 1000, -40)(frame),
    ),
  );

  assert.ok(
    near(facts.integratedLufs, -20, 0.5),
    `integrated loudness ${facts.integratedLufs} should follow the loud passage, not the quiet one`,
  );
  assert.ok(
    near(facts.rmsDbfs, -25.9, 0.5),
    `RMS ${facts.rmsDbfs} should average the whole file, quiet passage included`,
  );
  assert.ok(
    facts.integratedLufs !== null &&
      facts.rmsDbfs !== null &&
      facts.integratedLufs - facts.rmsDbfs >= 4,
    "the gate must separate integrated loudness from a plain average",
  );
});

test("stereo sums both channels, the same summation the loudness uses", () => {
  const mono = analyseLevel(pcm(24_000, 24_000, 1, sineAtRms(24_000, 1000, -26)));
  const dual = analyseLevel(
    pcm(24_000, 24_000, 2, (frame) => sineAtRms(24_000, 1000, -26)(frame)),
  );

  const deltaLufs =
    mono.integratedLufs !== null && dual.integratedLufs !== null
      ? dual.integratedLufs - mono.integratedLufs
      : null;
  const deltaRms =
    mono.rmsDbfs !== null && dual.rmsDbfs !== null ? dual.rmsDbfs - mono.rmsDbfs : null;

  assert.ok(near(deltaLufs, 3.01, LEVEL_TOLERANCE_DB), `two equal channels add ${deltaLufs} LU`);
  assert.ok(near(deltaRms, 3.01, LEVEL_TOLERANCE_DB), `two equal channels add ${deltaRms} dB RMS`);
  assert.equal(dual.truePeakDbtp, mono.truePeakDbtp, "a duplicated channel is not a louder peak");
});

test("a layout the analyser cannot weigh is refused by name", () => {
  const audio = pcm(24_000, 24_000, 3, () => 1000);

  assert.throws(
    () => analyseLevel(audio),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "LevelFactsError" &&
      (error as { code?: string }).code === "unsupported-layout",
  );

  const stereo = pcm(24_000, 100, 2, () => 1000);
  const ragged = { facts: stereo.facts, samples: stereo.samples.subarray(1) };
  assert.throws(
    () => analyseLevel(ragged),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === "invalid-layout",
  );
});

test("a level-shifted copy separates, so the level comparison can fail", () => {
  const clean = analyseLevel(pcm(24_000, 24_000, 1, sineAtRms(24_000, 1000, -20)));
  const shifted = analyseLevel(pcm(24_000, 24_000, 1, sineAtRms(24_000, 1000, -26)));
  const copy = analyseLevel(pcm(24_000, 24_000, 1, sineAtRms(24_000, 1000, -20)));
  const silent = analyseLevel(pcm(24_000, 24_000, 1, () => 0));

  const differs = compareLevels(clean, shifted);
  assert.equal(differs.status, "differs");
  assert.ok(near(differs.deltaLu, -6, LEVEL_TOLERANCE_DB), `delta ${differs.deltaLu} should be -6 LU`);
  assert.match(differs.detail, /6\.0\d LU/);
  assert.match(differs.detail, /-20\.0\d LUFS/);
  assert.match(differs.detail, /-26\.0\d LUFS/);

  assert.equal(compareLevels(clean, copy).status, "agrees");
  assert.equal(compareLevels(clean, silent).status, "unmeasured");
  assert.match(compareLevels(silent, clean).detail, /digital-silence/);
});
