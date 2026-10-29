/**
 * The three-way comparison is one table over the reference rendering, the
 * platform recording and the delivered capture. These tests build their own
 * WAVs, so every expected value comes from the signal — a known tone, a known
 * third harmonic, a known hole — and never from the analyser under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeWav } from "./format-facts";
import { compareCaptures, formatComparisonTable, type CaptureRole } from "./comparison";

const SAMPLE_RATE = 24_000;
const FULL_SCALE = 32_767;

/** A WAV built from float samples in [-1, 1], independently of the decoder. */
function wavFrom(samples: number[], sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const blockAlign = channels * 2;
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * blockAlign, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  samples.forEach((value, index) => {
    const scaled = Math.max(-1, Math.min(1, value)) * FULL_SCALE;
    out.writeInt16LE(Math.round(scaled), 44 + index * 2);
  });
  return out;
}

function tone(seconds: number, hz: number, amplitude: number, sampleRate = SAMPLE_RATE): number[] {
  const count = Math.round(seconds * sampleRate);
  return Array.from(
    { length: count },
    (_unused, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / sampleRate),
  );
}

function silence(seconds: number): number[] {
  return new Array<number>(Math.round(seconds * SAMPLE_RATE)).fill(0);
}

/** The row's three cells, in reference / platform / delivered order. */
function rowCells(table: string, label: string): string[] {
  const line = table.split("\n").find((entry) => entry.trimStart().startsWith(label));
  assert.ok(line, `the table has a "${label}" row`);
  return line.trim().split(/\s{2,}/).slice(1);
}

function compareFiles(files: {
  reference: Buffer;
  platform: Buffer;
  delivered: Buffer;
  sampleRate?: number;
}) {
  const decode = (bytes: Buffer) => decodeWav(bytes);
  const roles: CaptureRole[] = ["reference", "platform", "delivered"];
  return compareCaptures(
    roles.map((role) => ({
      role,
      path: `/captures/${role}.wav`,
      audio: decode(files[role]),
    })),
  );
}

test("the table reports format facts for all three files in one row each", () => {
  const reference = wavFrom(tone(1, 1_000, 0.5));
  const comparison = compareFiles({
    reference,
    platform: reference,
    delivered: reference,
  });
  const table = formatComparisonTable(comparison);

  assert.deepEqual(rowCells(table, "sample rate (Hz)"), ["24000", "24000", "24000"]);
  assert.deepEqual(rowCells(table, "channels"), ["1", "1", "1"]);
  assert.deepEqual(rowCells(table, "duration (s)"), ["1.00", "1.00", "1.00"]);
  assert.deepEqual(rowCells(table, "byte rate (B/s)"), ["48000", "48000", "48000"]);

  // Each file is named with its role, so a reader knows which column is which.
  assert.match(table, /reference\s+\/captures\/reference\.wav/);
  assert.match(table, /platform\s+\/captures\/platform\.wav/);
  assert.match(table, /delivered\s+\/captures\/delivered\.wav/);
});

test("the table reports integrated level, RMS and true peak for each file", () => {
  // A 1 kHz tone at half scale has a known RMS: 0.5/sqrt(2) is -9.03 dBFS.
  // The second file is 6.02 dB quieter, so the level row can disagree.
  const comparison = compareFiles({
    reference: wavFrom(tone(1, 1_000, 0.5)),
    platform: wavFrom(tone(1, 1_000, 0.25)),
    delivered: wavFrom(tone(1, 1_000, 0.5)),
  });
  const table = formatComparisonTable(comparison);

  assert.deepEqual(rowCells(table, "RMS (dBFS)"), ["-9.03", "-15.05", "-9.03"]);

  const [integrated, quiet] = rowCells(table, "integrated (LUFS)").map(Number);
  // BS.1770 reads a 1 kHz tone a little under a decibel from its RMS.
  assert.ok(Math.abs(integrated - -9.03) <= 1, `integrated ${integrated} LUFS is near the RMS`);
  assert.ok(
    Math.abs(quiet - integrated - -6.02) <= 0.1,
    `6 dB quieter reads ${quiet} LUFS against ${integrated} LUFS`,
  );

  const [truePeak] = rowCells(table, "true peak (dBTP)").map(Number);
  // A half-scale sine peaks at -6.02 dBTP; a reconstruction may read a shade high.
  assert.ok(Math.abs(truePeak - -6.02) <= 0.3, `true peak ${truePeak} dBTP`);
});

test("distortion residual is zero for a copy and names a known third harmonic", () => {
  // The delivered file is the reference plus a 1% third harmonic, which sits
  // at -40 dB relative to the fundamental: a reshaping the residual must see.
  const reference = tone(1, 440, 0.3);
  const withHarmonic = reference.map(
    (sample, index) =>
      sample + 0.01 * 0.3 * Math.sin((2 * Math.PI * 3 * 440 * index) / SAMPLE_RATE),
  );
  const comparison = compareFiles({
    reference: wavFrom(reference),
    platform: wavFrom(reference),
    delivered: wavFrom(withHarmonic),
  });
  const table = formatComparisonTable(comparison);

  assert.deepEqual(rowCells(table, "distortion vs reference (dB)").slice(0, 2), [
    "reference",
    "no residual",
  ]);
  const residual = Number(rowCells(table, "distortion vs reference (dB)")[2]);
  assert.ok(
    Math.abs(residual - -40) <= 2,
    `1% third harmonic reads ${residual} dB, expected -40 dB`,
  );
});

test("crest factor collapses on a squared-off file and stays high on a sine", () => {
  const sine = tone(1, 440, 0.5);
  const square = sine.map((sample) => (sample >= 0 ? 0.5 : -0.5));
  const comparison = compareFiles({
    reference: wavFrom(sine),
    platform: wavFrom(sine),
    delivered: wavFrom(square),
  });
  const table = formatComparisonTable(comparison);

  const [reference, platform, delivered] = rowCells(table, "crest factor (peak/RMS)").map(Number);
  assert.ok(reference > 1.4 && reference < 1.45, `a sine crests at 1.414, got ${reference}`);
  assert.equal(platform, reference);
  // A square wave is 1.0, below the 1.2 bar that separates clean speech.
  assert.ok(Math.abs(delivered - 1) <= 0.01, `a square wave crests at 1.0, got ${delivered}`);
  assert.ok(delivered < 1.2);
});

test("octave-band balance and the band-to-band delta are reported per file", () => {
  // Equal tones at 500 Hz and 4 kHz put the two ends of the quoted pair at the
  // same level, so the delta is zero; a file carrying only 500 Hz tilts down.
  const balanced = tone(1, 500, 0.3).map(
    (sample, index) => sample + 0.3 * Math.sin((2 * Math.PI * 4_000 * index) / SAMPLE_RATE),
  );
  const lowOnly = tone(1, 500, 0.3);
  const comparison = compareFiles({
    reference: wavFrom(balanced),
    platform: wavFrom(balanced),
    delivered: wavFrom(lowOnly),
  });
  const table = formatComparisonTable(comparison);

  // Both tones sit in their own octave band at 0.3/sqrt(2), or -13.5 dBFS.
  const [reference500, , delivered500] = rowCells(table, "500 Hz band (dBFS)").map(Number);
  assert.ok(Math.abs(reference500 - -13.5) <= 2, `500 Hz band reads ${reference500} dBFS`);
  assert.ok(Math.abs(delivered500 - -13.5) <= 2);

  const bandLabels = table
    .split("\n")
    .filter((line) => /^\s+\d+ Hz band \(dBFS\)/.test(line));
  assert.equal(bandLabels.length, 8, "a 24 kHz file carries all eight speech octaves");

  const [deltaReference, deltaPlatform, deltaDelivered] = rowCells(table, "band delta").map(Number);
  assert.ok(Math.abs(deltaReference) <= 1, `equal tones read ${deltaReference} dB of tilt`);
  assert.equal(deltaPlatform, deltaReference);
  assert.ok(
    deltaDelivered < -20,
    `a 500 Hz-only file reads ${deltaDelivered} dB between 500 Hz and 4 kHz`,
  );
  assert.match(table, /band delta 500→4000 Hz \(dB\)/);
  assert.match(table, /band spread \(dB\)/);
});

test("envelope modulation reports the rate and depth a flanging file carries", () => {
  // 20 Hz amplitude modulation at half depth: the chunk-rate artifact's shape.
  const modulated = tone(2, 1_000, 0.4).map(
    (sample, index) =>
      sample *
      (1 + 0.5 * Math.sin((2 * Math.PI * 20 * index) / SAMPLE_RATE)),
  );
  const steady = tone(2, 1_000, 0.4);
  const comparison = compareFiles({
    reference: wavFrom(steady),
    platform: wavFrom(steady),
    delivered: wavFrom(modulated),
  });
  const table = formatComparisonTable(comparison);

  const [referenceRate, , deliveredRate] = rowCells(table, "modulation rate (Hz)").map(Number);
  assert.equal(referenceRate, 0);
  assert.ok(Math.abs(deliveredRate - 20) <= 0.5, `modulation rate ${deliveredRate} Hz`);

  const [, , deliveredDepth] = rowCells(table, "modulation depth (%)").map(Number);
  assert.ok(Math.abs(deliveredDepth - 50) <= 5, `modulation depth ${deliveredDepth}%`);
  const [referenceDepth] = rowCells(table, "modulation depth (%)").map(Number);
  assert.equal(referenceDepth, 0);
});

test("breakup count, total and longest inserted silence are reported per file", () => {
  // Speech cut dead at full level, a 0.5 s hole, speech, a 0.12 s hole, speech:
  // the dry-buffer holes the owner hears as breakups.
  const speech = (seconds: number) => tone(seconds, 180, 0.35);
  const delivered = [
    ...speech(0.4),
    ...silence(0.5),
    ...speech(0.4),
    ...silence(0.12),
    ...speech(0.4),
  ];
  const clean = speech(1.72);
  const comparison = compareFiles({
    reference: wavFrom(clean),
    platform: wavFrom(clean),
    delivered: wavFrom(delivered),
  });
  const table = formatComparisonTable(comparison);

  assert.deepEqual(rowCells(table, "breakup count"), ["0", "0", "2"]);
  assert.deepEqual(rowCells(table, "breakup total silence (s)"), ["0.000", "0.000", "0.620"]);
  assert.deepEqual(rowCells(table, "breakup longest silence (s)"), ["0.000", "0.000", "0.500"]);
});

test("a capture with a lead-in reports its onset, so misalignment is visible", () => {
  const speech = tone(1, 500, 0.3);
  const comparison = compareFiles({
    reference: wavFrom(speech),
    platform: wavFrom(speech),
    delivered: wavFrom([...silence(0.5), ...speech]),
  });
  const table = formatComparisonTable(comparison);

  assert.deepEqual(rowCells(table, "onset (s)"), ["0.000", "0.000", "0.500"]);
});

test("files at different rates and channel counts are named, never a crash", () => {
  // A phone platform recording at 8 kHz beside a 24 kHz reference, and a
  // delivered capture carrying two channels. Everything per-file still prints;
  // only the cross-file residual refuses, and it says why.
  const reference = wavFrom(tone(1, 500, 0.3));
  const platform = wavFrom(tone(1, 500, 0.3), 8_000);
  const dualMono = tone(1, 500, 0.3).flatMap((sample) => [sample, sample]);
  const delivered = wavFrom(dualMono, SAMPLE_RATE, 2);

  const comparison = compareFiles({ reference, platform, delivered });
  const table = formatComparisonTable(comparison);

  assert.deepEqual(rowCells(table, "sample rate (Hz)"), ["24000", "8000", "24000"]);
  assert.deepEqual(rowCells(table, "channels"), ["1", "1", "2"]);
  assert.deepEqual(rowCells(table, "distortion vs reference (dB)"), [
    "reference",
    "unmeasured: format mismatch (24000 Hz x1ch vs 8000 Hz x1ch)",
    "unmeasured: format mismatch (24000 Hz x1ch vs 24000 Hz x2ch)",
  ]);

  // The shared bands stop where the narrowest file stops, and the delta is
  // quoted on one pair every column can measure.
  assert.match(table, /band delta 500→2000 Hz \(dB\)/);
  assert.doesNotMatch(table, /4000 Hz band/);
  assert.equal(rowCells(table, "RMS (dBFS)").length, 3);
});

test("the same three files produce the same table on two runs", () => {
  const reference = wavFrom(tone(0.5, 300, 0.4));
  const platform = wavFrom(tone(0.5, 300, 0.35));
  const delivered = wavFrom(tone(0.5, 300, 0.35));
  const first = compareFiles({ reference, platform, delivered });
  const second = compareFiles({ reference, platform, delivered });

  assert.equal(formatComparisonTable(first), formatComparisonTable(second));

  const ids = first.rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "every row id is unique for the verdict seam");
});

test("a channel layout the level metric refuses is named, not a crash", () => {
  // Level facts weigh one or two channels; three is refused by name. The rest
  // of the table still prints, so the cause is visible beside the numbers.
  const mono = tone(1, 500, 0.3);
  const threeChannel = mono.flatMap((sample) => [sample, sample, sample]);
  const comparison = compareFiles({
    reference: wavFrom(mono),
    platform: wavFrom(mono),
    delivered: wavFrom(threeChannel, SAMPLE_RATE, 3),
  });
  const table = formatComparisonTable(comparison);

  assert.deepEqual(rowCells(table, "channels"), ["1", "1", "3"]);
  const [, , deliveredRms] = rowCells(table, "RMS (dBFS)");
  assert.match(deliveredRms, /^unmeasured: .*declares 3\.$/);
  assert.equal(rowCells(table, "breakup count").length, 3);
});

test("exactly one capture per role is the contract", () => {
  const audio = decodeWav(wavFrom(tone(0.5, 500, 0.3)));
  const reference = { role: "reference" as const, path: "/captures/reference.wav", audio };
  const platform = { role: "platform" as const, path: "/captures/platform.wav", audio };

  assert.throws(
    () => compareCaptures([reference, platform]),
    /needs a delivered capture/,
  );
  assert.throws(
    () =>
      compareCaptures([
        reference,
        platform,
        { ...reference, role: "delivered" as const, path: "/captures/delivered.wav" },
        { ...reference, role: "delivered" as const, path: "/captures/delivered-2.wav" },
      ]),
    /2 delivered captures/,
  );
});
