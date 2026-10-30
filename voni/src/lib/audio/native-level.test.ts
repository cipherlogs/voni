/**
 * Native level: no gain stage on the cascade (W1 ticket 127).
 *
 * The tests build their own WAVs, so every expected level comes from the
 * signal (a known tone at a known scale), never from the analyser under test.
 * The level leg is asserted at the seam a gain stage would have to cross:
 *
 * - the comparison request (a `gain`/`volume`/`limiter` key is refused by
 *   name before any sample is read);
 * - the comparison's declared stage (anything but `none` is refused);
 * - the attribution of a delivered level difference to `our pipeline` or to
 *   the `client`, so a difference is a named defect rather than a knob;
 * - the measured native level itself (a 6.02 dB scale step reads as 6.02 LU).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  compareReferenceAndDelivered,
  type TwoCaptureComparison,
  type TwoCaptureRequest,
} from "./comparison";
import { decodeWav, type DecodedAudio } from "./format-facts";
import {
  GainStageError,
  LEVEL_STAGE_KEYS,
  MANAGED_LEVEL_KEY,
  NATIVE_GAIN_STAGE,
  assertNativeLevel,
  assertNoLevelStage,
  levelDefect,
  levelStageKeys,
} from "./native-level";

const SAMPLE_RATE = 24_000;
const FULL_SCALE = 32_767;

/** A WAV built from float samples in [-1, 1], independently of the decoder. */
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
  const count = Math.round(seconds * SAMPLE_RATE);
  return Array.from(
    { length: count },
    (_unused, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE),
  );
}

function decoded(bytes: Buffer): DecodedAudio {
  return decodeWav(bytes);
}

const LINE = { kind: "greeting" as const, text: "Hi, I'm Voni! Let's try something cool." };

function request(reference: Buffer, delivered: Buffer): TwoCaptureRequest {
  return {
    reference: { path: "/captures/reference.wav", audio: decoded(reference) },
    delivered: { path: "/captures/delivered.wav", audio: decoded(delivered) },
    line: LINE,
  };
}

function compare(reference: Buffer, delivered: Buffer): TwoCaptureComparison {
  return compareReferenceAndDelivered(request(reference, delivered));
}

test("native is the only cascade stage, and the managed level is not one", () => {
  assert.equal(NATIVE_GAIN_STAGE, "none");
  assert.equal(MANAGED_LEVEL_KEY, "output.volume");
  assert.ok(!(LEVEL_STAGE_KEYS as readonly string[]).includes(MANAGED_LEVEL_KEY));
  assert.deepEqual(assertNativeLevel(NATIVE_GAIN_STAGE), "none");
});

test("a gain, limiter or normalisation stage fails by name", () => {
  for (const stage of ["normalised", "limiter", "gain", "+6 dB"]) {
    assert.throws(
      () => assertNativeLevel(stage, 'clip "anna"'),
      (error: unknown) =>
        error instanceof GainStageError &&
        error.code === "gain-stage" &&
        error.message.includes(stage) &&
        error.message.includes('clip "anna"') &&
        /no output\.volume, no gain, no limiter/.test(error.message),
      `a "${stage}" stage is refused by name`,
    );
  }
});

test("a level knob on a cascade request is named before any sample is read", () => {
  assert.deepEqual(levelStageKeys({ voice_id: "anna", sample_rate: 24_000 }), []);
  assert.doesNotThrow(() => assertNoLevelStage({ voice_id: "anna" }, "comparison request"));

  assert.throws(
    () => assertNoLevelStage({ voice_id: "anna", gain: 6 }, "comparison request"),
    (error: unknown) =>
      error instanceof GainStageError &&
      error.code === "gain-stage" &&
      error.message.includes("gain") &&
      error.message.includes("comparison request"),
  );
  assert.throws(
    () =>
      assertNoLevelStage(
        { volume: 90, limiter: true, normalisation: "ebu" },
        "comparison request",
      ),
    (error: unknown) =>
      error instanceof GainStageError &&
      ["volume", "limiter", "normalisation"].every((key) => error.message.includes(key)),
    "every level key is named, not only the first",
  );
});

test("a gain stage introduced into the comparison request fails by name", () => {
  const reference = wavFrom(tone(1, 1_000, 0.5));
  const delivered = wavFrom(tone(1, 1_000, 0.5));
  const doctored = { ...request(reference, delivered), gain: 6 } as TwoCaptureRequest;

  assert.throws(
    () => compareReferenceAndDelivered(doctored),
    (error: unknown) =>
      error instanceof GainStageError &&
      error.code === "gain-stage" &&
      error.message.includes("gain"),
    "a gain key on the cascade comparison path is a named failure",
  );
});

test("the level leg reads native level: a 6.02 dB scale step is a 6.02 LU delta", () => {
  const reference = wavFrom(tone(2, 1_000, 0.5));
  const delivered = wavFrom(tone(2, 1_000, 0.25));

  const comparison = compare(reference, delivered);
  assert.equal(comparison.status, "measured", comparison.unresolvedReasons.join("; "));
  assert.equal(comparison.gainStage, "none");

  const defect = levelDefect(comparison);
  assert.ok(defect !== null, "a 6.02 LU difference is a named defect");
  assert.equal(defect.layer, "our pipeline");
  assert.ok(Math.abs(defect.deltaLu - -6.02) <= 0.1, `delta ${defect.deltaLu} LU`);
  assert.match(defect.detail, /over the 1\.5 LU bar/);
});

test("a level difference within the bar is not a defect", () => {
  const reference = wavFrom(tone(2, 1_000, 0.5));
  const delivered = wavFrom(tone(2, 1_000, 0.5));

  assert.equal(levelDefect(compare(reference, delivered)), null);
});

test("a bounded gain dip in playback is named as a client defect, not a pipeline gain", () => {
  const reference = tone(2, 1_000, 0.5);
  // The client plays 80% of the line 14 dB down and recovers before the end:
  // a bounded fade, which the pipeline audit masks out before comparing level.
  const delivered = reference.map((sample, index) => {
    const seconds = index / SAMPLE_RATE;
    return seconds >= 0.2 && seconds < 1.8 ? sample * 0.2 : sample;
  });

  const comparison = compare(wavFrom(reference), wavFrom(delivered));
  const fade = comparison.clientSignatures.find((signature) => signature.kind === "boundary-fade");
  assert.equal(fade?.detected, true, "the dip is detected as the client's boundary fade");

  const defect = levelDefect(comparison);
  assert.ok(defect !== null, "the unmasked level difference is named");
  assert.equal(defect.layer, "client");
  assert.match(defect.detail, /client/);
  assert.match(defect.detail, /masked/);
});

test("an unmeasured level is never a zero and never a defect", () => {
  const reference = wavFrom(tone(2, 1_000, 0.5));
  const delivered = wavFrom(new Array<number>(2 * SAMPLE_RATE).fill(0));

  const defect = levelDefect(compare(reference, delivered));
  assert.equal(defect, null);
});

test("a comparison carrying any stage but native is refused by name", () => {
  const comparison = compare(wavFrom(tone(1, 1_000, 0.5)), wavFrom(tone(1, 1_000, 0.5)));

  for (const stage of ["normalised", "limiter"]) {
    assert.throws(
      () => levelDefect({ ...comparison, gainStage: stage } as unknown as TwoCaptureComparison),
      (error: unknown) =>
        error instanceof GainStageError && error.message.includes(stage),
      `the level leg refuses a "${stage}" stage`,
    );
  }
});
