/**
 * The verdict is one sentence after the table: the first layer where the three
 * captures diverge, named as reference, platform, model text or client.
 *
 * Every case builds its own WAVs, so the expected layer comes from the signal
 * (a known hole, a known level step, a known transcript) and never from the
 * verdict module's own reading.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeWav } from "./format-facts";
import { compareCaptures, type CaptureRole } from "./comparison";
import { decideVerdict, type Verdict } from "./verdict";
import { SCOREBOARD_BUDGETS } from "../demo/scoreboard-budgets";

const SAMPLE_RATE = 24_000;
const FULL_SCALE = 32_767;

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

/** Speak, hold dead at speech level, speak again: the hole a starved buffer leaves. */
function speechWithHole(seconds = 0.4, hole = 0.5): number[] {
  return [
    ...tone(seconds, 180, 0.35),
    ...silence(hole),
    ...tone(seconds, 180, 0.35),
    ...tone(seconds, 180, 0.35),
  ];
}

function verdictFor(files: {
  reference: Buffer;
  platform: Buffer;
  delivered: Buffer;
  intendedLine?: string;
  transcript?: string;
}): Verdict {
  const roles: CaptureRole[] = ["reference", "platform", "delivered"];
  const comparison = compareCaptures(
    roles.map((role) => ({
      role,
      path: `/captures/${role}.wav`,
      audio: decodeWav(files[role]),
    })),
  );
  return decideVerdict({
    comparison,
    intendedLine: files.intendedLine,
    transcript: files.transcript,
  });
}

test("delivered audio that gains a hole the platform does not have is named the client", () => {
  const line = tone(1.7, 180, 0.35);
  const verdict = verdictFor({
    reference: wavFrom(line),
    platform: wavFrom(line),
    delivered: wavFrom(speechWithHole()),
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "client");
  assert.equal(verdict.axis, "breakups");
  assert.match(verdict.sentence, /^The first divergence is the client: /);
  assert.match(verdict.sentence, /inserted silence/);
  assert.match(verdict.sentence, /playback/);
});

test("three matching captures are reported as no divergence, not as a guess", () => {
  const line = tone(1, 500, 0.4);
  const verdict = verdictFor({
    reference: wavFrom(line),
    platform: wavFrom(line),
    delivered: wavFrom(line),
  });

  assert.equal(verdict.status, "none");
  assert.equal(verdict.subject, null);
  assert.match(verdict.sentence, /^No divergence: /);
});

test("a platform capture quieter than the reference, delivered faithfully, is named the platform", () => {
  // 6.02 dB down: the platform recording already differs and the delivered
  // file is a copy of it, so the client cannot be the layer that broke.
  const verdict = verdictFor({
    reference: wavFrom(tone(1.2, 500, 0.4)),
    platform: wavFrom(tone(1.2, 500, 0.2)),
    delivered: wavFrom(tone(1.2, 500, 0.2)),
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "platform");
  assert.equal(verdict.axis, "level");
  assert.match(verdict.sentence, /^The first divergence is the platform: /);
  assert.match(verdict.sentence, /6\.0 dB below the reference/);
  assert.match(verdict.sentence, /not the client/);
  // No line or transcript was supplied, so the verdict says so instead of
  // claiming model text was cleared.
  assert.match(verdict.sentence, /model text was not checked: no intended line or transcript supplied/);
  assert.ok(
    verdict.thresholds.some((entry) => entry.key === "comparisonLevelLu" && entry.value === 1.5),
    "the level bar is cited from the frozen record",
  );
});

test("a reference at the full-scale ceiling is named reference, not blamed downstream", () => {
  const clipped = tone(1, 500, 1);
  const verdict = verdictFor({
    reference: wavFrom(clipped),
    platform: wavFrom(clipped),
    delivered: wavFrom(clipped),
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "reference");
  assert.match(verdict.sentence, /^The first divergence is the reference itself: /);
  assert.match(verdict.sentence, /full-scale ceiling/);
  assert.match(verdict.sentence, /fix the reference capture/);
  assert.ok(verdict.thresholds.some((entry) => entry.key === "comparisonReferenceClipDbtp"));
});

test("a reference that already carries an inserted silence is named reference", () => {
  const broken = wavFrom(speechWithHole());
  const verdict = verdictFor({
    reference: broken,
    platform: broken,
    delivered: broken,
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "reference");
  assert.match(verdict.sentence, /^The first divergence is the reference itself: /);
  assert.match(verdict.sentence, /inserted silence/);
});

test("a platform transcript that is not the intended line is named model text", () => {
  const line = tone(1, 500, 0.4);
  const verdict = verdictFor({
    reference: wavFrom(line),
    platform: wavFrom(line),
    delivered: wavFrom(line),
    intendedLine: "Your appointment is at four o'clock.",
    transcript: "Your appointment is at nine o'clock.",
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "model text");
  assert.equal(verdict.axis, null);
  assert.match(verdict.sentence, /^The first divergence is model text: /);
  assert.match(verdict.sentence, /four o'clock/);
  assert.match(verdict.sentence, /nine o'clock/);
  assert.ok(verdict.thresholds.some((entry) => entry.key === "comparisonModelTextWordChanges"));
});

test("the same line, punctuated differently, is not a text divergence", () => {
  const line = tone(1, 500, 0.4);
  const verdict = verdictFor({
    reference: wavFrom(line),
    platform: wavFrom(line),
    delivered: wavFrom(line),
    intendedLine: "Your appointment is at four o'clock.",
    transcript: "your appointment is at four o'clock",
  });

  assert.equal(verdict.status, "none");
  assert.equal(verdict.subject, null);
});

test("a lead-in that leaves the captures unaligned is unresolved, never the client", () => {
  const line = tone(1, 500, 0.4);
  const verdict = verdictFor({
    reference: wavFrom(line),
    platform: wavFrom(line),
    delivered: wavFrom([...silence(0.4), ...line]),
  });

  assert.equal(verdict.status, "unresolved");
  assert.equal(verdict.subject, null);
  assert.match(verdict.sentence, /^The verdict is unresolved: /);
  assert.match(verdict.sentence, /not aligned/);
  assert.match(verdict.sentence, /0\.400 s/);
  assert.match(verdict.sentence, /0\.050 s bar/);
  assert.doesNotMatch(verdict.sentence, /client:/);
  assert.ok(verdict.thresholds.some((entry) => entry.key === "comparisonOnsetToleranceS"));
});

test("an axis that cannot be measured makes the verdict insufficient, not a pass", () => {
  // A phone platform recording at 8 kHz cannot carry the cross-rate distortion
  // residual, so a clean level and tilt cannot clear the client either.
  const reference = wavFrom(tone(1, 500, 0.4));
  const platform = wavFrom(tone(1, 500, 0.4), 8_000);
  const verdict = verdictFor({
    reference,
    platform,
    delivered: wavFrom(tone(1, 500, 0.4), 8_000),
  });

  assert.equal(verdict.status, "unresolved");
  assert.equal(verdict.subject, null);
  assert.match(verdict.sentence, /no divergence was measured/);
  assert.match(verdict.sentence, /distortion could not be measured/);
  assert.match(verdict.sentence, /cannot clear the client/);
});

test("delivered audio whose level moves after playback is named the client", () => {
  const verdict = verdictFor({
    reference: wavFrom(tone(1, 1_000, 0.4)),
    platform: wavFrom(tone(1, 1_000, 0.4)),
    delivered: wavFrom(tone(1, 1_000, 0.2)),
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "client");
  assert.equal(verdict.axis, "level");
  assert.match(verdict.sentence, /the delivered audio is 6\.0 dB below the platform/);
});

test("a cushion artifact the platform does not carry is named the client as modulation", () => {
  const steady = tone(2, 1_000, 0.4);
  const modulated = steady.map(
    (sample, index) => sample * (1 + 0.5 * Math.sin((2 * Math.PI * 20 * index) / SAMPLE_RATE)),
  );
  const verdict = verdictFor({
    reference: wavFrom(steady),
    platform: wavFrom(steady),
    delivered: wavFrom(modulated),
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "client");
  assert.equal(verdict.axis, "modulation");
  assert.match(verdict.sentence, /envelope modulation/);
});

test("a platform capture with a different octave balance is named platform as spectrum", () => {
  // Equal 500 Hz and 4 kHz tones become a darker mix within 0.9 dB of the same
  // loudness: the 500→4000 Hz tilt moves 8.8 dB, well past the 3 dB bar.
  const balanced = tone(1, 500, 0.3).map(
    (sample, index) => sample + 0.3 * Math.sin((2 * Math.PI * 4_000 * index) / SAMPLE_RATE),
  );
  const darker = tone(1, 500, 0.44).map(
    (sample, index) => sample + 0.16 * Math.sin((2 * Math.PI * 4_000 * index) / SAMPLE_RATE),
  );
  const verdict = verdictFor({
    reference: wavFrom(balanced),
    platform: wavFrom(darker),
    delivered: wavFrom(darker),
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "platform");
  assert.equal(verdict.axis, "spectrum");
  assert.match(verdict.sentence, /octave tilt/);
});

test("a platform capture reshaped by a third harmonic is named platform as distortion", () => {
  // The ticket 14 probe: a 1% third harmonic reads -40 dB, inside the -45 dB bar.
  const fundamental = tone(1, 440, 0.3);
  const reshaped = fundamental.map(
    (sample, index) => sample + 0.01 * 0.3 * Math.sin((2 * Math.PI * 3 * 440 * index) / SAMPLE_RATE),
  );
  const verdict = verdictFor({
    reference: wavFrom(fundamental),
    platform: wavFrom(reshaped),
    delivered: wavFrom(reshaped),
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "platform");
  assert.equal(verdict.axis, "distortion");
  assert.match(verdict.sentence, /residual reshaping/);
});

test("delivered audio reshaped by a third harmonic is named the client as distortion", () => {
  // A clean platform copy gains a 1% third harmonic only in playback; the
  // absolute -45 dB bar applies because the platform had no residual at all.
  const fundamental = tone(1, 440, 0.3);
  const reshaped = fundamental.map(
    (sample, index) => sample + 0.01 * 0.3 * Math.sin((2 * Math.PI * 3 * 440 * index) / SAMPLE_RATE),
  );
  const verdict = verdictFor({
    reference: wavFrom(fundamental),
    platform: wavFrom(fundamental),
    delivered: wavFrom(reshaped),
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.subject, "client");
  assert.equal(verdict.axis, "distortion");
  assert.match(verdict.sentence, /residual reshaping/);
});

test("model text outranks an audio divergence because the words broke first", () => {
  const verdict = verdictFor({
    reference: wavFrom(tone(1, 500, 0.4)),
    platform: wavFrom(tone(1, 500, 0.2)),
    delivered: wavFrom(tone(1, 500, 0.2)),
    intendedLine: "Your appointment is at four o'clock.",
    transcript: "Your appointment is at nine o'clock.",
  });

  assert.equal(verdict.subject, "model text");
});

test("the verdict names one divergence and does not list every difference", () => {  // The platform is 6 dB quiet AND the delivered file adds a hole and
  // modulation. The first layer is the platform, and the sentence must not
  // recite the later differences.
  const steady = tone(2, 1_000, 0.4);
  const quiet = tone(2, 1_000, 0.2);
  const noisyDelivered = quiet
    .slice(0, 12_000)
    .concat(silence(0.4), quiet.slice(12_000))
    .map((sample, index) => sample * (1 + 0.5 * Math.sin((2 * Math.PI * 20 * index) / SAMPLE_RATE)));
  const verdict = verdictFor({
    reference: wavFrom(steady),
    platform: wavFrom(quiet),
    delivered: wavFrom(noisyDelivered),
  });

  assert.equal(verdict.subject, "platform");
  assert.equal(verdict.axis, "level");
  assert.equal(
    (verdict.sentence.match(/dB/g) ?? []).length,
    1,
    `one measurement, got: ${verdict.sentence}`,
  );
  assert.doesNotMatch(verdict.sentence, /inserted|modulation|tilt|distortion/);
});

test("a clean verdict cites every comparison bar as the frozen record holds it", () => {
  const line = tone(1, 500, 0.4);
  const verdict = verdictFor({
    reference: wavFrom(line),
    platform: wavFrom(line),
    delivered: wavFrom(line),
  });
  const recorded = Object.keys(SCOREBOARD_BUDGETS)
    .filter((key) => key.startsWith("comparison"))
    .sort();

  assert.deepEqual(
    verdict.thresholds.map((entry) => entry.key).sort(),
    recorded,
    "a new comparison bar cannot ship without being cited",
  );
  for (const entry of verdict.thresholds) {
    assert.equal(entry.value, SCOREBOARD_BUDGETS[entry.key].value);
    assert.equal(entry.unit, SCOREBOARD_BUDGETS[entry.key].unit);
  }
});
