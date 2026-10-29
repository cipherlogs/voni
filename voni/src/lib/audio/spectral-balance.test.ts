/**
 * Spectral balance is how a comparison names a layer: an octave band that a
 * copy lost, or a tilt that a copy introduced, has to show up as a number in
 * that band rather than as a single aggregate level.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAudioFile, type DecodedAudio } from "./format-facts";
import {
  SPEECH_OCTAVE_CENTRES,
  measureSpectralBalance,
} from "./spectral-balance";

const SAMPLE_RATE = 24_000;

/** Sum of sines, one per octave centre, so every band carries the same level. */
function octaveSignal(options: {
  seconds?: number;
  /** Amplitude per band, or a function of the band centre. */
  amplitudeAt?: (centreHz: number) => number;
  /** Centres to leave out of the signal, as a copy with a lost band would. */
  omitHz?: readonly number[];
}): Int16Array {
  const { seconds = 2, amplitudeAt = () => 0.1, omitHz = [] } = options;
  const frameCount = Math.round(seconds * SAMPLE_RATE);
  const samples = new Int16Array(frameCount);
  for (const centreHz of SPEECH_OCTAVE_CENTRES) {
    if (omitHz.includes(centreHz)) continue;
    const amplitude = amplitudeAt(centreHz);
    for (let frame = 0; frame < frameCount; frame++) {
      samples[frame] += amplitude * Math.sin((2 * Math.PI * centreHz * frame) / SAMPLE_RATE) * 32_768;
    }
  }
  for (let frame = 0; frame < frameCount; frame++) {
    samples[frame] = Math.max(-32_768, Math.min(32_767, Math.round(samples[frame])));
  }
  return samples;
}

/** Wrap samples in the decoded shape the analyser consumes, without a file. */
function decoded(samples: Int16Array, channels = 1): DecodedAudio {
  const frameCount = samples.length / channels;
  return {
    facts: {
      container: "pcm",
      sampleRate: SAMPLE_RATE,
      channels,
      bitsPerSample: 16,
      byteRate: SAMPLE_RATE * channels * 2,
      dataBytes: samples.length * 2,
      frameCount,
      durationSeconds: frameCount / SAMPLE_RATE,
    },
    samples,
  };
}

/** A minimal s16le WAV, written independently of the analyser under test. */
function wavOf(samples: Int16Array, sampleRate: number, channels = 1): Buffer {
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
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}

test("a flat synthetic signal reports a flat band balance", () => {
  const balance = measureSpectralBalance(decoded(octaveSignal({})));

  assert.equal(balance.silent, false);
  assert.deepEqual(
    balance.bands.map((band) => band.centreHz),
    [...SPEECH_OCTAVE_CENTRES],
  );
  // One 0.1-amplitude sine per band puts every band at 0.1/sqrt(2) RMS:
  // 20*log10(0.0707) = -23.0 dBFS. Known-good arithmetic, not a recomputation
  // of the analyser.
  for (const band of balance.bands) {
    assert.ok(
      Math.abs(band.levelDb - -23.01) < 0.5,
      `${band.centreHz} Hz reads ${band.levelDb.toFixed(2)} dBFS, expected about -23.0`,
    );
  }
  assert.ok(balance.spreadDb < 0.5, `spread ${balance.spreadDb.toFixed(2)} dB is not flat`);
  assert.equal(balance.balanced, true);
});

test("a known tilt reports the expected band-to-band delta and fails the balanced threshold", () => {
  // Bands up to 500 Hz at 0.25, bands from 1 kHz down 12 dB at a quarter of it.
  const balance = measureSpectralBalance(
    decoded(octaveSignal({ amplitudeAt: (centreHz) => (centreHz <= 500 ? 0.25 : 0.0625) })),
  );

  assert.equal(balance.silent, false);
  assert.equal(balance.tilt.fromCentreHz, 500);
  assert.equal(balance.tilt.toCentreHz, 4000);
  // A 4:1 amplitude ratio is 20*log10(4) = 12.04 dB down.
  assert.ok(
    Math.abs(balance.tilt.deltaDb - -12.04) < 0.5,
    `tilt reads ${balance.tilt.deltaDb.toFixed(2)} dB, expected about -12.0`,
  );
  assert.ok(balance.spreadDb > 6, `spread ${balance.spreadDb.toFixed(2)} dB should exceed the 6 dB bar`);
  assert.equal(balance.balanced, false);
  assert.match(balance.detail, /spectral tilt -12\.\d dB between 500 Hz and 4000 Hz/);
});

test("a band removed from the copy is visible in its own octave band", () => {
  const reference = measureSpectralBalance(decoded(octaveSignal({})));
  const copy = measureSpectralBalance(decoded(octaveSignal({ omitHz: [1000] })));

  const deltas = copy.bands.map((band, index) => ({
    centreHz: band.centreHz,
    deltaDb: Number((band.levelDb - reference.bands[index].levelDb).toFixed(2)),
  }));
  const lost = deltas.find((band) => band.centreHz === 1000);
  assert.ok(lost !== undefined);
  assert.ok(lost.deltaDb < -40, `1000 Hz moved only ${lost.deltaDb} dB, expected the band to vanish`);

  for (const band of deltas) {
    if (band.centreHz === 1000) continue;
    assert.ok(
      Math.abs(band.deltaDb) < 0.5,
      `${band.centreHz} Hz moved ${band.deltaDb} dB even though only the 1000 Hz band was removed`,
    );
  }

  assert.deepEqual(
    copy.missingBands.map((band) => band.centreHz),
    [1000],
  );
  assert.equal(copy.balanced, false);
  assert.match(copy.detail, /octave band lost: 1000 Hz/);
});

test("the output is stable across two runs on the same file", () => {
  const dir = mkdtempSync(join(tmpdir(), "voni-spectral-balance-"));
  const path = join(dir, "delivered.wav");
  try {
    const samples = octaveSignal({ amplitudeAt: (centreHz) => (centreHz <= 250 ? 0.2 : 0.05) });
    writeFileSync(path, wavOf(samples, SAMPLE_RATE));

    const first = measureSpectralBalance(decodeAudioFile(path));
    const second = measureSpectralBalance(decodeAudioFile(path));

    assert.deepEqual(second, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a silent file is unmeasured, never a flat balance", () => {
  const balance = measureSpectralBalance(decoded(new Int16Array(SAMPLE_RATE)));

  assert.equal(balance.silent, true);
  assert.equal(balance.balanced, false);
  assert.match(balance.detail, /^silent: /);
});
