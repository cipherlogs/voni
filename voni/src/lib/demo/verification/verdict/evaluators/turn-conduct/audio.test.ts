import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyseWav, signature, similarity } from "./audio";

/**
 * The delivered WAV is the visitor's audio. These tests build real PCM16
 * files — tones, silence and a repeated burst — so the analysis is judged on
 * samples, not on a declared duration.
 */

const RATE = 24_000;
const roots: string[] = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Span = { kind: "tone" | "silence"; ms: number; freq?: number; amplitude?: number };

function wav(spans: readonly Span[]): string {
  const samples: number[] = [];
  for (const span of spans) {
    const count = Math.round((span.ms / 1000) * RATE);
    for (let index = 0; index < count; index += 1) {
      if (span.kind === "silence") {
        samples.push(0);
      } else {
        const value = Math.sin((2 * Math.PI * (span.freq ?? 440) * index) / RATE);
        samples.push(Math.round(value * 12_000 * (span.amplitude ?? 1)));
      }
    }
  }
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, index) => bytes.writeInt16LE(value, 44 + index * 2));
  const root = mkdtempSync(join(tmpdir(), "dv19-wav-"));
  roots.push(root);
  const file = join(root, "delivered.wav");
  writeFileSync(file, bytes);
  return file;
}

test("a WAV's voiced segments are found from its samples, not its header", () => {
  const file = wav([
    { kind: "silence", ms: 300 },
    { kind: "tone", ms: 500 },
    { kind: "silence", ms: 250 },
    { kind: "tone", ms: 400, freq: 660 },
    { kind: "silence", ms: 200 },
  ]);
  const analysis = analyseWav(file);
  assert.equal(analysis.sampleRate, RATE);
  assert.ok(Math.abs(analysis.durationMs - 1_650) <= 1, `duration ${analysis.durationMs}`);
  assert.equal(analysis.segments.length, 2, JSON.stringify(analysis.segments));
  const [first, second] = analysis.segments;
  assert.ok(first!.startMs >= 280 && first!.startMs <= 340, `first start ${first!.startMs}`);
  assert.ok(first!.endMs >= 780 && first!.endMs <= 840, `first end ${first!.endMs}`);
  assert.ok(second!.startMs >= 1_020 && second!.startMs <= 1_090, `second start ${second!.startMs}`);
  assert.equal(analysis.firstVoicedMs, first!.startMs);
  assert.equal(analysis.lastVoicedMs, second!.endMs);
});

test("a capture with no voiced frame reports no voice, not a shorter file", () => {
  const analysis = analyseWav(wav([{ kind: "silence", ms: 900 }]));
  assert.equal(analysis.segments.length, 0);
  assert.equal(analysis.firstVoicedMs, null);
  assert.equal(analysis.lastVoicedMs, null);
});

test("a repeated burst is similar to itself and a different tone is not", () => {
  const file = wav([
    { kind: "tone", ms: 600 },
    { kind: "silence", ms: 100 },
    { kind: "tone", ms: 600 },
    { kind: "silence", ms: 100 },
    { kind: "tone", ms: 600, freq: 880 },
  ]);
  const analysis = analyseWav(file);
  assert.equal(analysis.segments.length, 3);
  const [one, two, three] = analysis.segments;
  const first = signature(analysis, one!);
  const same = signature(analysis, two!);
  const other = signature(analysis, three!);
  assert.ok(similarity(first, same) > 0.95);
  assert.ok(similarity(first, other) < 0.75);
});

test("a malformed WAV is a named refusal, never a short capture", () => {
  const root = mkdtempSync(join(tmpdir(), "dv19-wav-bad-"));
  roots.push(root);
  const file = join(root, "broken.wav");
  writeFileSync(file, Buffer.from("not a wav at all"));
  assert.throws(() => analyseWav(file), /not a RIFF\/WAVE file/);
});
