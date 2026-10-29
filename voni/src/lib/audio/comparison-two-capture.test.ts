/**
 * The W0 two-capture comparison: one table over the reference rendering and
 * the delivered capture, with no platform leg. These tests build their own
 * WAVs, so every expected value comes from the signal (a known tone, a known
 * third harmonic, a known hole) and never from the analyser under test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decodeWav, type DecodedAudio } from "./format-facts";
import {
  TWO_CAPTURE_ROLES,
  compareReferenceAndDelivered,
  formatTwoCaptureTable,
  type TwoCaptureComparison,
  type TwoCaptureRole,
} from "./comparison";

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

function decoded(bytes: Buffer): DecodedAudio {
  return decodeWav(bytes);
}

const GREETING = {
  kind: "greeting" as const,
  text: "Hi, I'm Voni! Let's try something cool.",
};

function compare(reference: Buffer, delivered: Buffer, line = GREETING): TwoCaptureComparison {
  return compareReferenceAndDelivered({
    reference: { path: "/captures/reference.wav", audio: decoded(reference) },
    delivered: { path: "/captures/delivered.wav", audio: decoded(delivered) },
    line,
  });
}

function value(
  comparison: TwoCaptureComparison,
  id: string,
  role: TwoCaptureRole,
): number | { text: string } | { unmeasured: string } {
  const row = comparison.rows.find((candidate) => candidate.id === id);
  assert.ok(row, `the table has a "${id}" row`);
  const cell = row.cells[role];
  if (cell.kind === "value") return cell.value;
  if (cell.kind === "text") return { text: cell.text };
  return { unmeasured: cell.reason };
}

test("two synthetic files pin every metric row and name its producer", () => {
  // The reference is a 1 kHz tone at half scale; the delivered file is the same
  // tone 6.02 dB quieter, with a 1% third harmonic, a squared-off crest and a
  // delay, so every metric has something independent to read.
  const reference = tone(1, 1_000, 0.5);
  const delivered = tone(1, 1_000, 0.25).map(
    (sample, index) => sample + 0.0025 * Math.sin((2 * Math.PI * 3_000 * index) / SAMPLE_RATE),
  );

  const comparison = compare(wavFrom(reference), wavFrom(delivered));

  assert.equal(comparison.status, "measured", comparison.unresolvedReasons.join("; "));
  assert.equal(comparison.gainStage, "none", "the table measures the captures at native level");
  assert.deepEqual(
    comparison.rows.map((row) => row.id),
    [
      "sample-rate",
      "channels",
      "duration",
      "byte-rate",
      "onset",
      "integrated",
      "rms",
      "true-peak",
      "distortion",
      "crest",
      "octave-63",
      "octave-125",
      "octave-250",
      "octave-500",
      "octave-1000",
      "octave-2000",
      "octave-4000",
      "octave-8000",
      "band-spread",
      "band-delta",
      "modulation-rate",
      "modulation-depth",
      "breakup-count",
      "breakup-total",
      "breakup-longest",
    ],
  );

  // Every metric names the module that produced it, so a reader can find the
  // implementation rather than trusting a number with no provenance.
  const producers = new Map(comparison.rows.map((row) => [row.id, row.producer]));
  for (const row of comparison.rows) {
    assert.match(row.producer, /^[a-z-]+\.[a-zA-Z]+$/, `${row.id} names a producer`);
  }
  assert.equal(producers.get("sample-rate"), "format-facts.decodeWav");
  assert.equal(producers.get("onset"), "comparison.measureOnset");
  assert.equal(producers.get("integrated"), "level-facts.analyseLevel");
  assert.equal(producers.get("distortion"), "distortion-crest.distortionResidual");
  assert.equal(producers.get("crest"), "distortion-crest.crestFactor");
  assert.equal(producers.get("octave-500"), "spectral-balance.measureSpectralBalance");
  assert.equal(producers.get("modulation-rate"), "envelope-modulation.measureEnvelopeModulation");
  assert.equal(producers.get("breakup-count"), "breakups.detectBreakups");

  assert.equal(value(comparison, "sample-rate", "reference"), 24_000);
  assert.equal(value(comparison, "channels", "delivered"), 1);
  assert.equal(value(comparison, "duration", "reference"), 1);
  assert.equal(value(comparison, "byte-rate", "delivered"), 48_000);

  // RMS is a known -9.03 dBFS at half scale and -15.05 dBFS at quarter scale.
  const [referenceRms, deliveredRms] = TWO_CAPTURE_ROLES.map(
    (role) => value(comparison, "rms", role) as number,
  );
  assert.ok(Math.abs(referenceRms - -9.03) <= 0.01, `reference RMS ${referenceRms} dBFS`);
  assert.ok(Math.abs(deliveredRms - -15.05) <= 0.01, `delivered RMS ${deliveredRms} dBFS`);
  const [referenceLevel, deliveredLevel] = TWO_CAPTURE_ROLES.map(
    (role) => value(comparison, "integrated", role) as number,
  );
  assert.ok(
    Math.abs(deliveredLevel - referenceLevel - -6.02) <= 0.1,
    `native level delta is ${(deliveredLevel - referenceLevel).toFixed(2)} LU, not a gain stage`,
  );

  const truePeak = value(comparison, "true-peak", "reference") as number;
  assert.ok(Math.abs(truePeak - -6.02) <= 0.3, `true peak ${truePeak} dBTP`);

  // The delivered residual is the 1% third harmonic at -40 dB. The reference is
  // the baseline, never a reading against itself.
  assert.deepEqual(value(comparison, "distortion", "reference"), { text: "reference" });
  const residual = value(comparison, "distortion", "delivered") as number;
  assert.ok(Math.abs(residual - -40) <= 2, `1% third harmonic reads ${residual} dB`);

  const crest = value(comparison, "crest", "reference") as number;
  assert.ok(crest > 1.4 && crest < 1.45, `a sine crests at 1.414, got ${crest}`);

  // The 1 kHz tone sits in the 1 kHz octave band; the other bands are present
  // as rows whether or not the signal carries energy in them.
  const band = value(comparison, "octave-1000", "reference") as number;
  assert.ok(Math.abs(band - -9) <= 3, `1 kHz band reads ${band} dBFS`);
  assert.equal(comparison.octaveBandsHz.length, 8);

  const rate = value(comparison, "modulation-rate", "reference") as number;
  assert.equal(rate, 0);
  assert.equal(value(comparison, "breakup-count", "delivered"), 0);
  assert.equal(value(comparison, "breakup-total", "delivered"), 0);
  assert.equal(value(comparison, "breakup-longest", "delivered"), 0);

  const table = formatTwoCaptureTable(comparison);
  assert.match(table, /W0 two-capture comparison/);
  assert.match(table, /reference\s+\/captures\/reference\.wav/);
  assert.match(table, /delivered\s+\/captures\/delivered\.wav/);
  assert.doesNotMatch(table, /platform/);
  assert.match(table, /producer/);
  assert.match(table, /level-facts\.analyseLevel/);
});

test("modulation and occurred silences are pinned on the two-capture table", () => {
  // A steady 1 kHz reference, and a delivered file that carries the 20 Hz,
  // half-depth cushion artifact plus one inserted 0.5 s hole. The values come
  // from the signal, not from the analyser under test.
  const steady = tone(2, 1_000, 0.4);
  const modulated = steady.map(
    (sample, index) => sample * (1 + 0.5 * Math.sin((2 * Math.PI * 20 * index) / SAMPLE_RATE)),
  );
  const comparison = compare(wavFrom(steady), wavFrom(modulated));
  assert.equal(comparison.status, "measured", comparison.unresolvedReasons.join("; "));
  const rate = value(comparison, "modulation-rate", "delivered") as number;
  assert.ok(Math.abs(rate - 20) <= 0.5, `modulation rate ${rate} Hz`);
  const depth = value(comparison, "modulation-depth", "delivered") as number;
  assert.ok(Math.abs(depth - 50) <= 5, `modulation depth ${depth}%`);
  assert.equal(value(comparison, "modulation-rate", "reference"), 0);

  // Every octave band row carries a number for both files, so a missing band
  // is visible instead of silently absent.
  const bandIds = comparison.octaveBandsHz.map((centre) => `octave-${centre}`);
  for (const id of bandIds) {
    assert.equal(typeof value(comparison, id, "reference"), "number", `${id} reference`);
    assert.equal(typeof value(comparison, id, "delivered"), "number", `${id} delivered`);
  }

  // A separate delivered file carries one inserted 0.5 s hole and no
  // modulation, so the breakup rows are pinned independently of the envelope.
  const holed = [
    ...steady.slice(0, Math.round(0.4 * SAMPLE_RATE)),
    ...silence(0.5),
    ...steady.slice(Math.round(0.9 * SAMPLE_RATE)),
  ];
  const withHole = compare(wavFrom(steady), wavFrom(holed));
  assert.equal(withHole.status, "measured", withHole.unresolvedReasons.join("; "));
  assert.equal(value(withHole, "breakup-count", "delivered"), 1);
  assert.ok(
    Math.abs((value(withHole, "breakup-total", "delivered") as number) - 0.5) <= 0.03,
    `breakup total ${value(withHole, "breakup-total", "delivered")}`,
  );
  assert.ok(
    Math.abs((value(withHole, "breakup-longest", "delivered") as number) - 0.5) <= 0.03,
    `breakup longest ${value(withHole, "breakup-longest", "delivered")}`,
  );
  assert.equal(value(withHole, "breakup-count", "reference"), 0);
});

test("a missing or truncated capture is unresolved, never a pass", () => {
  const reference = wavFrom(tone(1, 500, 0.3));
  const decodedReference = decoded(reference);

  const missing = compareReferenceAndDelivered({
    reference: { path: "/captures/reference.wav", audio: decodedReference },
    delivered: null,
    line: GREETING,
  });
  assert.equal(missing.status, "unresolved");
  assert.match(missing.unresolvedReasons.join(" "), /delivered capture missing/);
  assert.deepEqual(value(missing, "rms", "delivered"), {
    unmeasured: "delivered capture missing: no file supplied",
  });
  assert.equal(typeof value(missing, "rms", "reference"), "number");
  assert.equal(
    missing.rows.some((row) => row.cells.delivered.kind === "value"),
    false,
    "no delivered cell is a measured value when the capture is gone",
  );

  const truncated = compareReferenceAndDelivered({
    reference: { path: "/captures/reference.wav", audio: decodedReference },
    delivered: {
      path: "/captures/delivered.wav",
      kind: "truncated",
      reason: "the worklet never acked its final block",
    },
    line: GREETING,
  });
  assert.equal(truncated.status, "unresolved");
  assert.match(truncated.unresolvedReasons.join(" "), /delivered capture truncated/);
  assert.match(truncated.unresolvedReasons.join(" "), /tap-timeout|acked/i);
});

test("the greeting marker measures only the greeting, not the whole call", () => {
  // The reference is one second of a 1 kHz tone. The delivered capture is that
  // same second, then two seconds of a different, much louder line. Only the
  // marked greeting may be compared; the later turn is not a breakup or a
  // distortion against this reference.
  const reference = tone(1, 1_000, 0.3);
  const delivered = [...reference, ...tone(2, 250, 0.9)];
  const comparison = compare(wavFrom(reference), wavFrom(delivered));

  assert.equal(comparison.status, "measured", comparison.unresolvedReasons.join("; "));
  assert.equal(value(comparison, "duration", "delivered"), 1);
  const residual = value(comparison, "distortion", "delivered");
  if (typeof residual === "number") {
    assert.ok(residual < -60, `a copy reads ${residual} dB of residual`);
  } else {
    assert.deepEqual(residual, { text: "no residual" }, "a copy has no residual");
  }
  assert.equal(value(comparison, "breakup-count", "delivered"), 0);

  // A marked segment works the same way: it names the exact window to compare.
  const marked = compareReferenceAndDelivered({
    reference: { path: "/captures/reference.wav", audio: decoded(wavFrom(tone(0.5, 1_000, 0.3))) },
    delivered: {
      path: "/captures/delivered.wav",
      audio: decoded(wavFrom([...silence(2), ...tone(0.5, 1_000, 0.3), ...silence(1)])),
    },
    line: { kind: "segment", text: GREETING.text, startSeconds: 2, endSeconds: 2.5 },
  });
  assert.equal(marked.status, "measured", marked.unresolvedReasons.join("; "));
  assert.equal(value(marked, "duration", "delivered"), 0.5);
});

test("an onset difference beyond the frozen 50 ms bar is unresolved", () => {
  const speech = tone(0.5, 500, 0.3);
  const within = compare(
    wavFrom(speech),
    wavFrom([...silence(0.04), ...speech]),
  );
  assert.equal(within.status, "measured", within.unresolvedReasons.join("; "));
  assert.equal(within.alignment.sampleAligned, true);
  assert.ok(
    Math.abs(within.alignment.onsetDeltaSeconds! - 0.04) <= 0.01,
    `onset delta ${within.alignment.onsetDeltaSeconds}`,
  );

  const beyond = compare(
    wavFrom(speech),
    wavFrom([...silence(0.08), ...speech]),
  );
  assert.equal(beyond.status, "unresolved");
  assert.match(beyond.unresolvedReasons.join(" "), /onsets differ by 0\.08/);
  assert.match(beyond.unresolvedReasons.join(" "), /0\.050 s bar/);
  assert.equal(beyond.alignment.sampleAligned, false);
});

test("a format mismatch is unresolved and the residual says why", () => {
  const mono = tone(0.5, 500, 0.3);
  const stereo = mono.flatMap((sample) => [sample, sample]);
  const comparison = compare(wavFrom(mono), wavFrom(stereo, SAMPLE_RATE, 2));

  assert.equal(comparison.status, "unresolved");
  assert.match(comparison.unresolvedReasons.join(" "), /format mismatch/);
  assert.match(
    String((value(comparison, "distortion", "delivered") as { unmeasured: string }).unmeasured),
    /format mismatch/,
  );
});

test("a whole-call capture without a line marker is refused as incomplete", () => {
  const reference = wavFrom(tone(1, 500, 0.3));
  const delivered = wavFrom(tone(1, 500, 0.3));

  const comparison = compareReferenceAndDelivered({
    reference: { path: "/captures/reference.wav", audio: decoded(reference) },
    delivered: { path: "/captures/delivered.wav", audio: decoded(delivered) },
    line: null,
  });

  assert.equal(comparison.status, "unresolved");
  assert.match(comparison.unresolvedReasons.join(" "), /line marker/i);
  assert.match(comparison.unresolvedReasons.join(" "), /greeting line or a marked segment/i);
  assert.notEqual(comparison.status, "measured");
});
