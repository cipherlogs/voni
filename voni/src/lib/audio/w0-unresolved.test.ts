/**
 * W0 unresolved rules (ticket 123).
 *
 * A comparison that cannot be made says so: a missing, unreadable, zero-byte,
 * header-only, stereo, wrong-rate or misdescribed capture is `unresolved` with
 * a named reason, never a silent zero. An onset beyond the frozen 50 ms bar, a
 * format mismatch and a different line are unresolved too. No unresolved case
 * can be printed as a pass.
 *
 * Every expected value comes from the signal or the WAV header this file
 * writes; nothing is read back from the module under test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decodeWav, type DecodedAudio } from "./format-facts";
import {
  compareReferenceAndDelivered,
  formatTwoCaptureTable,
  type TwoCaptureComparison,
  type TwoCaptureDescription,
  type TwoCaptureRequest,
  type TwoCaptureRole,
  type TwoCaptureSlot,
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

function silence(seconds: number, sampleRate = SAMPLE_RATE): number[] {
  return new Array<number>(Math.round(seconds * sampleRate)).fill(0);
}

const GREETING = {
  kind: "greeting" as const,
  text: "Hi, I'm Voni! Let's try something cool.",
};

function decoded(bytes: Buffer): DecodedAudio {
  return decodeWav(bytes);
}

function slot(
  bytes: Buffer,
  path = "/captures/capture.wav",
  description?: TwoCaptureDescription,
): TwoCaptureSlot {
  return { path, audio: decoded(bytes), ...(description ? { description } : {}) };
}

function compare(request: Partial<TwoCaptureRequest> = {}): TwoCaptureComparison {
  const line = tone(0.5, 500, 0.3);
  return compareReferenceAndDelivered({
    reference: slot(wavFrom(line), "/captures/reference.wav"),
    delivered: slot(wavFrom(line), "/captures/delivered.wav"),
    line: GREETING,
    ...request,
  });
}

function cell(
  comparison: TwoCaptureComparison,
  id: string,
  role: TwoCaptureRole,
): { kind: string; value?: number; reason?: string; text?: string } {
  const row = comparison.rows.find((candidate) => candidate.id === id);
  assert.ok(row, `the table has a "${id}" row`);
  const entry = row.cells[role];
  return entry.kind === "value"
    ? { kind: "value", value: entry.value }
    : entry.kind === "text"
      ? { kind: "text", text: entry.text }
      : { kind: "unmeasured", reason: entry.reason };
}

function reasonText(comparison: TwoCaptureComparison): string {
  return comparison.unresolvedReasons.join("; ");
}

test("a header-only capture is unresolved with a named reason, never a silent zero", () => {
  // 44 bytes of RIFF header and no sample frames: a file that looks present and
  // carries nothing to measure.
  const headerOnly = wavFrom([]);
  assert.equal(decoded(headerOnly).facts.frameCount, 0);

  const comparison = compare({ delivered: slot(headerOnly, "/captures/delivered.wav") });

  assert.equal(comparison.status, "unresolved");
  assert.match(reasonText(comparison), /delivered capture header-only/i);
  assert.match(reasonText(comparison), /0 sample frames/i);

  const rms = cell(comparison, "rms", "delivered");
  assert.equal(rms.kind, "unmeasured");
  assert.match(String(rms.reason), /header-only/i);
  assert.equal(
    comparison.rows.some((row) => row.cells.delivered.kind === "value"),
    false,
    "no delivered cell carries a number when the file has no frames",
  );
});

test("a zero-byte capture is unresolved and says the file was empty", () => {
  const comparison = compare({
    delivered: {
      path: "/captures/delivered.wav",
      kind: "zero-byte",
      reason: "the tap wrote a file and no bytes",
    },
  });

  assert.equal(comparison.status, "unresolved");
  assert.match(reasonText(comparison), /delivered capture zero-byte/i);
  assert.match(reasonText(comparison), /no bytes/);
  assert.equal(comparison.captures.find((capture) => capture.role === "delivered")?.present, false);
});

test("a stereo capture is unresolved even when both files are stereo", () => {
  // Both files agree on format, so only the W0 profile's mono rule can refuse
  // this: a stereo delivered capture is not the worklet's mono output.
  const mono = tone(0.5, 500, 0.3);
  const stereo = mono.flatMap((sample) => [sample, sample]);
  const comparison = compare({
    reference: slot(wavFrom(stereo, SAMPLE_RATE, 2), "/captures/reference.wav"),
    delivered: slot(wavFrom(stereo, SAMPLE_RATE, 2), "/captures/delivered.wav"),
  });

  assert.equal(comparison.status, "unresolved");
  assert.match(reasonText(comparison), /2 channels/);
  assert.match(reasonText(comparison), /mono/i);
});

test("a capture at the wrong rate is unresolved against the call's format", () => {
  // The call negotiated 24 kHz. Both files are 16 kHz, so they agree with each
  // other while disagreeing with the call; that is a wrong-rate capture, not a
  // comparison the table may silently make.
  const comparison = compare({
    reference: slot(
      wavFrom(tone(0.5, 500, 0.3, 16_000), 16_000),
      "/captures/reference.wav",
    ),
    delivered: slot(
      wavFrom(tone(0.5, 500, 0.3, 16_000), 16_000),
      "/captures/delivered.wav",
    ),
    expectedFormat: { sampleRate: SAMPLE_RATE, channels: 1 },
  });

  assert.equal(comparison.status, "unresolved");
  assert.match(reasonText(comparison), /16000 Hz/);
  assert.match(reasonText(comparison), /24000 Hz/);
  assert.match(reasonText(comparison), /wrong-rate|does not match the call/i);
});

test("a misdescribed capture is unresolved: the description and the file disagree", () => {
  const comparison = compare({
    delivered: {
      path: "/captures/delivered.wav",
      audio: decoded(wavFrom(tone(0.5, 500, 0.3))),
      description: { sampleRate: 48_000, channels: 1 },
    },
  });

  assert.equal(comparison.status, "unresolved");
  assert.match(reasonText(comparison), /delivered capture misdescribed/i);
  assert.match(reasonText(comparison), /48000/);
  assert.match(reasonText(comparison), /24000/);
});

test("a capture described as a different line is unresolved, not compared", () => {
  const comparison = compare({
    reference: {
      path: "/captures/reference.wav",
      audio: decoded(wavFrom(tone(0.5, 500, 0.3))),
      description: { text: "Your appointment is at four o'clock." },
    },
  });

  assert.equal(comparison.status, "unresolved");
  assert.match(reasonText(comparison), /reference capture misdescribed/i);
  assert.match(reasonText(comparison), /four o'clock/);
  assert.match(reasonText(comparison), /Voni/);
});

test("an onset difference beyond 50 ms, a format mismatch and a different line stay unresolved", () => {
  const line = tone(0.5, 500, 0.3);
  const late = compare({
    delivered: slot(
      wavFrom([...silence(0.08), ...line]),
      "/captures/delivered.wav",
    ),
  });
  assert.equal(late.status, "unresolved");
  assert.match(reasonText(late), /onsets differ by 0\.08/);

  const stereo = compare({
    delivered: slot(
      wavFrom(line.flatMap((sample) => [sample, sample]), SAMPLE_RATE, 2),
      "/captures/delivered.wav",
    ),
  });
  assert.equal(stereo.status, "unresolved");
  assert.match(reasonText(stereo), /format mismatch|2 channels/);

  const differentLine = compareReferenceAndDelivered({
    reference: slot(wavFrom(line), "/captures/reference.wav"),
    delivered: slot(wavFrom(line), "/captures/delivered.wav"),
    line: GREETING,
    spokenLine: "Your appointment is at nine o'clock.",
  });
  assert.equal(differentLine.status, "unresolved");
  assert.match(reasonText(differentLine), /different line/i);
});

test("an unmeasured metric is UNMEASURED with its reason, never a silent zero", () => {
  // A file shorter than one 400 ms loudness block is present and decodable, but
  // it carries no integrated level. The cell says why instead of reporting
  // 0 LUFS.
  const short = tone(0.2, 500, 0.3);
  const comparison = compare({
    reference: slot(wavFrom(short), "/captures/reference.wav"),
    delivered: slot(wavFrom(short), "/captures/delivered.wav"),
  });

  assert.equal(comparison.status, "measured", reasonText(comparison));
  const level = cell(comparison, "integrated", "delivered");
  assert.equal(level.kind, "unmeasured");
  assert.match(String(level.reason), /too-short|no measurable level/i);
  assert.notEqual(level.value, 0);
});

test("the printed table says unresolved and prints every reason, never a pass", () => {
  const comparison = compare({
    delivered: {
      path: "/captures/delivered.wav",
      kind: "missing",
      reason: "no file",
    },
  });
  const table = formatTwoCaptureTable(comparison);

  assert.match(table, /status\s+unresolved/);
  assert.match(table, /delivered capture missing/);
  assert.doesNotMatch(table, /status\s+measured/);
});
