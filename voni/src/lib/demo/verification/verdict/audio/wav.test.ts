import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tone, wavBytes, writeWav } from "./test-pcm";
import { AudioEvidenceError, readDeliveredCapture } from "./wav";

function declared(file: string, facts: { sampleRate: number; frames: number; durationMs: number; bytes: number }) {
  return {
    file,
    sampleRate: facts.sampleRate,
    channels: 1 as const,
    bitsPerSample: 16 as const,
    frames: facts.frames,
    durationMs: facts.durationMs,
    bytes: facts.bytes,
  };
}

test("a delivered capture is read from the file and agrees with its declared facts", () => {
  const audio = tone(0.5);
  const file = writeWav("delivered.wav", audio);
  const bytes = wavBytes(audio).byteLength;
  const capture = readDeliveredCapture(
    declared(file, {
      sampleRate: audio.facts.sampleRate,
      frames: audio.facts.frameCount,
      durationMs: audio.facts.durationSeconds * 1000,
      bytes,
    }),
  );

  assert.equal(capture.file, file);
  assert.equal(capture.audio.facts.frameCount, audio.facts.frameCount);
  assert.equal(capture.bytes, bytes);
});

test("a missing delivered capture is refused by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "dv21-wav-"));
  assert.throws(
    () => readDeliveredCapture(declared(join(dir, "absent.wav"), { sampleRate: 24_000, frames: 1, durationMs: 1, bytes: 1 })),
    (error: unknown) =>
      error instanceof AudioEvidenceError && error.code === "wav-missing",
  );
});

test("a file that is not RIFF/WAVE is unreadable, not a short capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "dv21-wav-"));
  const file = join(dir, "delivered.wav");
  writeFileSync(file, "this is not audio");
  assert.throws(
    () => readDeliveredCapture(declared(file, { sampleRate: 24_000, frames: 1, durationMs: 1, bytes: 17 })),
    (error: unknown) =>
      error instanceof AudioEvidenceError && error.code === "wav-unreadable",
  );
});

test("a WAV whose declared rate disagrees with its header is misdescribed", () => {
  const audio = tone(0.2);
  const file = writeWav("delivered.wav", audio);
  assert.throws(
    () =>
      readDeliveredCapture(
        declared(file, {
          sampleRate: 48_000,
          frames: audio.facts.frameCount,
          durationMs: audio.facts.durationSeconds * 1000,
          bytes: wavBytes(audio).byteLength,
        }),
      ),
    (error: unknown) =>
      error instanceof AudioEvidenceError &&
      error.code === "wav-misdescribed" &&
      /48000 Hz/.test(error.message) &&
      /24000 Hz/.test(error.message),
  );
});

test("a multi-channel capture is a format refusal", () => {
  const mono = tone(0.2);
  const samples = new Int16Array(mono.samples.length * 2);
  for (let index = 0; index < mono.samples.length; index += 1) {
    samples[index * 2] = mono.samples[index]!;
    samples[index * 2 + 1] = mono.samples[index]!;
  }
  const stereo = {
    samples,
    facts: { ...mono.facts, channels: 2, dataBytes: samples.byteLength, byteRate: 96_000 },
  };
  const file = writeWav("delivered.wav", stereo);
  assert.throws(
    () =>
      readDeliveredCapture({
        file,
        sampleRate: 24_000,
        channels: 1,
        bitsPerSample: 16,
        frames: mono.facts.frameCount,
        durationMs: mono.facts.durationSeconds * 1000,
        bytes: wavBytes(stereo).byteLength,
      }),
    (error: unknown) =>
      error instanceof AudioEvidenceError && error.code === "wav-format",
  );
});

test("browser capture metadata that names another file is refused", () => {
  const audio = tone(0.2);
  const file = writeWav("delivered.wav", audio);
  const evidence = declared(file, {
    sampleRate: 24_000,
    frames: audio.facts.frameCount,
    durationMs: audio.facts.durationSeconds * 1000,
    bytes: wavBytes(audio).byteLength,
  });
  assert.throws(
    () =>
      readDeliveredCapture(evidence, {
        capture: {
          file: "/somewhere/else.wav",
          bytes: evidence.bytes,
          sampleRate: evidence.sampleRate,
          seconds: evidence.durationMs / 1000,
        },
      }),
    (error: unknown) =>
      error instanceof AudioEvidenceError && error.code === "browser-capture-mismatch",
  );
});
