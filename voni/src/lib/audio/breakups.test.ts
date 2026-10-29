/**
 * Breakups are inserted silences in delivered audio: a hole inside a phrase,
 * not the pause between phrases. These tests build their own WAVs, so the
 * expected count, total and longest silence come from the signal, not from
 * the analyser under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeWav } from "./format-facts";
import { detectBreakups } from "./breakups";

const SAMPLE_RATE = 24_000;
const FULL_SCALE = 32_767;
const SPEECH_AMPLITUDE = 0.35;
const TONE_HZ = 180;

/** A WAV built from float samples in [-1, 1], independently of the decoder. */
function wavFrom(samples: number[], channels = 1): Buffer {
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
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
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

/** Voiced speech at a steady level, so an adjacent cut is at full level. */
function speech(seconds: number): number[] {
  const count = Math.round(seconds * SAMPLE_RATE);
  return Array.from(
    { length: count },
    (_unused, index) =>
      SPEECH_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE),
  );
}

/** Digital silence: exactly the inserted hole a starving buffer produces. */
function silence(seconds: number): number[] {
  return new Array<number>(Math.round(seconds * SAMPLE_RATE)).fill(0);
}

/** The tail of a phrase: a linear decay to zero over `seconds`. */
function decay(seconds: number): number[] {
  const count = Math.round(seconds * SAMPLE_RATE);
  return Array.from(
    { length: count },
    (_unused, index) =>
      SPEECH_AMPLITUDE *
      Math.sin((2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE) *
      (1 - index / count),
  );
}

/** The head of a phrase: a linear rise from zero over `seconds`. */
function rise(seconds: number): number[] {
  const count = Math.round(seconds * SAMPLE_RATE);
  return Array.from(
    { length: count },
    (_unused, index) =>
      SPEECH_AMPLITUDE *
      Math.sin((2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE) *
      (index / count),
  );
}

function decode(samples: number[], channels = 1) {
  return decodeWav(wavFrom(samples, channels));
}

test("a clean recording with a natural pause reports zero breakups", () => {
  // A phrase, then the voice decays into the pause and rises out of it. The
  // pause is digital silence, so only the shape of its edges separates it
  // from an inserted hole.
  const audio = decode([
    ...speech(0.5),
    ...decay(0.12),
    ...silence(0.3),
    ...rise(0.12),
    ...speech(0.5),
  ]);

  const report = detectBreakups(audio);

  assert.equal(report.count, 0);
  assert.deepEqual(report.breakups, []);
  assert.equal(report.totalSeconds, 0);
  assert.equal(report.longestSeconds, 0);
});

test("one inserted silence is reported once, with its duration", () => {
  // Speech cut dead at full level, half a second of nothing, then speech
  // resumed dead at full level: the dry-buffer hole the owner hears.
  const audio = decode([...speech(0.4), ...silence(0.5), ...speech(0.4)]);

  const report = detectBreakups(audio);

  assert.equal(report.count, 1);
  assert.equal(report.breakups.length, 1);
  assert.ok(
    Math.abs(report.breakups[0].startSeconds - 0.4) <= 0.015,
    `starts at ${report.breakups[0].startSeconds}s, expected 0.4s`,
  );
  assert.ok(
    Math.abs(report.breakups[0].durationSeconds - 0.5) <= 0.015,
    `lasts ${report.breakups[0].durationSeconds}s, expected 0.5s`,
  );
  assert.ok(Math.abs(report.totalSeconds - 0.5) <= 0.015);
  assert.ok(Math.abs(report.longestSeconds - 0.5) <= 0.015);
});

test("several inserted silences report their count, total and longest", () => {
  const audio = decode([
    ...speech(0.4),
    ...silence(0.12),
    ...speech(0.4),
    ...silence(0.35),
    ...speech(0.4),
    ...silence(0.5),
    ...speech(0.4),
  ]);

  const report = detectBreakups(audio);

  assert.equal(report.count, 3);
  const durations = report.breakups.map((breakup) => breakup.durationSeconds);
  [0.12, 0.35, 0.5].forEach((expected, index) => {
    assert.ok(
      Math.abs(durations[index] - expected) <= 0.015,
      `breakup ${index} lasts ${durations[index]}s, expected ${expected}s`,
    );
  });
  assert.ok(Math.abs(report.totalSeconds - 0.97) <= 0.03);
  assert.ok(Math.abs(report.longestSeconds - 0.5) <= 0.015);
});

test("a natural pause is not counted even beside an inserted silence", () => {
  const audio = decode([
    ...speech(0.5),
    ...decay(0.12),
    ...silence(0.4),
    ...rise(0.12),
    ...speech(0.4),
    ...silence(0.5),
    ...speech(0.4),
  ]);

  const report = detectBreakups(audio);

  assert.equal(report.count, 1);
  assert.ok(
    Math.abs(report.breakups[0].startSeconds - 1.54) <= 0.02,
    `starts at ${report.breakups[0].startSeconds}s, expected the inserted hole at 1.54s`,
  );
  assert.ok(Math.abs(report.breakups[0].durationSeconds - 0.5) <= 0.015);
});

test("leading and trailing silence is not a breakup, only a hole between speech", () => {
  const audio = decode([
    ...silence(0.5),
    ...speech(0.3),
    ...silence(0.4),
    ...speech(0.3),
    ...silence(0.5),
  ]);

  const report = detectBreakups(audio);

  assert.equal(report.count, 1);
  assert.ok(
    Math.abs(report.breakups[0].startSeconds - 0.8) <= 0.015,
    `starts at ${report.breakups[0].startSeconds}s, expected the interior hole at 0.8s`,
  );
});

test("a dropout shorter than the shortest hole worth naming is not counted", () => {
  const audio = decode([...speech(0.4), ...silence(0.01), ...speech(0.4)]);

  const report = detectBreakups(audio);

  assert.equal(report.count, 0);
  assert.equal(report.totalSeconds, 0);
});

test("a hole in both channels of a stereo file is one breakup, not two", () => {
  const mono = [...speech(0.4), ...silence(0.5), ...speech(0.4)];
  const stereo = mono.flatMap((sample) => [sample, sample]);
  const audio = decode(stereo, 2);

  const report = detectBreakups(audio);

  assert.equal(report.count, 1);
  assert.ok(Math.abs(report.breakups[0].durationSeconds - 0.5) <= 0.015);
});
