/**
 * Floor mode: a subject clears the vendor floor when it is at least as good on
 * every measured axis. These tests hold the one property that makes the floor a
 * gate rather than a diff — being *different* from the floor does not fail, and
 * being *worse* on any one axis does, with that axis named.
 *
 * Every fixture is built from tones, so the expected standing comes from the
 * signal (a known gain difference, a known third harmonic, a known hole, a
 * known envelope swing) and never from the analyser under test. The axis
 * directions are asserted in both directions: a subject that is worse fails,
 * and the same axis read the other way passes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeWav, type DecodedAudio } from "./format-facts";
import {
  FLOOR_AXIS_DIRECTIONS,
  FLOOR_AXIS_THRESHOLDS,
  compareToFloor,
  formatFloorVerdict,
  type FloorAxis,
  type FloorAxisStanding,
  type FloorComparison,
  type FloorReference,
} from "./floor-mode";
import { loadVendorFloor } from "./vendor-floor";

const SAMPLE_RATE = 24_000;
const FULL_SCALE = 32_767;

/** A WAV built from float samples in [-1, 1], independently of the decoder. */
function wavFrom(samples: number[], sampleRate = SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
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

function tone(seconds: number, hz: number, amplitude: number, sampleRate = SAMPLE_RATE): number[] {
  const count = Math.round(seconds * sampleRate);
  return Array.from(
    { length: count },
    (_unused, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / sampleRate),
  );
}

/** A tone whose envelope swings at `rateHz`; `depth` is peak-to-trough over mean. */
function modulated(
  seconds: number,
  hz: number,
  amplitude: number,
  rateHz: number,
  depth: number,
): number[] {
  return tone(seconds, hz, amplitude).map(
    (sample, index) => sample * (1 + depth * Math.sin((2 * Math.PI * rateHz * index) / SAMPLE_RATE)),
  );
}

function scaled(samples: number[], gain: number): number[] {
  return samples.map((sample) => sample * gain);
}

function decode(samples: number[], sampleRate = SAMPLE_RATE): DecodedAudio {
  return decodeWav(wavFrom(samples, sampleRate));
}

/** A floor at a fixed path, so every summary can be checked for its citation. */
function floorFrom(
  samples: number[],
  options: { path?: string; withProvenance?: boolean } = {},
): FloorReference {
  return {
    path: options.path ?? "/evidence/vendor-floor/anna-en.wav",
    audio: decode(samples),
    ...(options.withProvenance === false
      ? {}
      : {
          provenance: {
            voice: "anna",
            locale: "en",
            line: "Hi, I'm Voni! Let's try something cool.",
            capturedOn: "2026-10-29",
          },
        }),
  };
}

function subjectOf(reference: number[], delivered: number[], sampleRate = SAMPLE_RATE) {
  return {
    reference: { path: "/captures/reference.wav", audio: decode(reference, sampleRate) },
    delivered: { path: "/captures/delivered.wav", audio: decode(delivered, sampleRate) },
  };
}

function standingOf(comparison: FloorComparison, axis: FloorAxis): FloorAxisStanding {
  const reading = comparison.axes.find((entry) => entry.axis === axis);
  assert.ok(reading, `the comparison reports the ${axis} axis`);
  return reading.standing;
}

test("every axis states the direction in which a subject is worse", () => {
  assert.deepEqual(Object.keys(FLOOR_AXIS_DIRECTIONS).sort(), [
    "breakups",
    "distortion",
    "level",
    "modulation",
    "peak",
  ]);
  for (const [axis, direction] of Object.entries(FLOOR_AXIS_DIRECTIONS)) {
    assert.ok(direction.length > 20, `${axis} documents which side is worse`);
  }
  // The two tolerances this module adds are declared with their source.
  assert.ok(FLOOR_AXIS_THRESHOLDS.modulationDepth > 0);
  assert.ok(FLOOR_AXIS_THRESHOLDS.breakupSeconds > 0);
});

test("a subject better than the floor on every axis passes and cites the floor", () => {
  // The floor carries a 15% envelope swing, so the subject is cleaner in shape,
  // has more peak headroom and a smaller residual against the same reference.
  const reference = tone(2, 220, 0.4);
  const comparison = compareToFloor({
    floor: floorFrom(modulated(2, 220, 0.4, 25, 0.15)),
    subject: subjectOf(reference, reference),
  });

  assert.equal(comparison.verdict, "pass");
  assert.equal(standingOf(comparison, "level"), "equal");
  assert.equal(standingOf(comparison, "peak"), "better");
  assert.equal(standingOf(comparison, "distortion"), "better");
  assert.equal(standingOf(comparison, "modulation"), "better");
  assert.equal(standingOf(comparison, "breakups"), "equal");
  assert.deepEqual(comparison.worse, []);

  // The verdict is not a number: it cites the committed floor it was judged on.
  assert.match(comparison.summary, /PASSES against the vendor floor/);
  assert.match(comparison.summary, /\/evidence\/vendor-floor\/anna-en\.wav/);
  assert.match(comparison.summary, /anna\/en/);
  assert.match(comparison.summary, /2026-10-29/);
});

test("a subject worse on level fails and names level", () => {
  const comparison = compareToFloor({
    floor: floorFrom(tone(2, 220, 0.4)),
    subject: subjectOf(tone(2, 220, 0.4), tone(2, 220, 0.3)),
  });

  assert.equal(comparison.verdict, "fail");
  assert.equal(standingOf(comparison, "level"), "worse");
  assert.match(comparison.summary, /FAILS/);
  assert.match(comparison.summary, /worse on level/);
  // -2.5 dB is beyond the 0.2 LU target, and the floor is cited beside it.
  assert.match(comparison.summary, /2\.5\d LU/);
  assert.match(comparison.summary, /anna-en\.wav/);
});

test("a subject worse on distortion fails and names distortion", () => {
  // The delivered file is the reference plus a 1% third harmonic: -40 dB
  // residual, well above the -60 dB clean-file bar the floor clears.
  const reference = tone(2, 220, 0.4);
  const reshaped = reference.map(
    (sample, index) =>
      sample + 0.01 * 0.4 * Math.sin((2 * Math.PI * 3 * 220 * index) / SAMPLE_RATE),
  );
  const comparison = compareToFloor({
    floor: floorFrom(reference),
    subject: subjectOf(reference, reshaped),
  });

  assert.equal(comparison.verdict, "fail");
  assert.equal(standingOf(comparison, "distortion"), "worse");
  assert.equal(standingOf(comparison, "level"), "equal");
  assert.match(comparison.summary, /worse on distortion/);
  assert.match(comparison.summary, /-4\d\.\d dB/);
});

test("a subject worse on breakups fails and names breakups", () => {
  // Speech cut dead for 60 ms: a hole the floor does not have.
  const speech = tone(2, 220, 0.4);
  const holey = [...speech.slice(0, 19_200), ...new Array(1_440).fill(0), ...speech.slice(20_640)];
  const comparison = compareToFloor({
    floor: floorFrom(speech),
    subject: subjectOf(speech, holey),
  });

  assert.equal(comparison.verdict, "fail");
  assert.equal(standingOf(comparison, "breakups"), "worse");
  assert.match(comparison.summary, /worse on breakups/);
  assert.match(comparison.summary, /0\.060 s/);
});

test("a subject worse on modulation fails and names modulation", () => {
  // A 20% swing at 20 Hz: the chunk-rate artifact the owner hears, on a subject
  // whose mean level stays inside tolerance.
  const reference = tone(2, 220, 0.4);
  const comparison = compareToFloor({
    floor: floorFrom(reference),
    subject: subjectOf(reference, modulated(2, 220, 0.4, 20, 0.2)),
  });

  assert.equal(comparison.verdict, "fail");
  assert.equal(standingOf(comparison, "modulation"), "worse");
  assert.match(comparison.summary, /worse on modulation/);
  assert.match(comparison.summary, /20\.\d%/);
});

test("a subject merely different but not worse does not fail", () => {
  // 0.18 LU quieter and 0.18 dB more peak headroom: a different level and a
  // different peak, both on the not-worse side of their axis.
  const reference = tone(2, 220, 0.4);
  const comparison = compareToFloor({
    floor: floorFrom(reference),
    subject: subjectOf(reference, scaled(reference, 0.98)),
  });

  assert.equal(comparison.verdict, "pass");
  assert.equal(standingOf(comparison, "level"), "equal");
  assert.equal(standingOf(comparison, "peak"), "equal");
  assert.equal(standingOf(comparison, "distortion"), "equal");
  assert.deepEqual(comparison.worse, []);
  assert.match(comparison.summary, /PASSES/);
  // It is different, not identical: the level moved and stayed inside tolerance.
  const level = comparison.axes.find((axis) => axis.axis === "level");
  assert.ok(level);
  assert.match(level.detail, /0\.18 LU/);
  assert.match(level.detail, /within/);
});

test("less true-peak headroom than the floor is worse, more headroom is better", () => {
  const reference = tone(2, 220, 0.4);
  // A 10 ms transient at 0.9 near the start: same level, far less headroom.
  const peaky = [...reference];
  for (let index = 4_800; index < 5_040; index++) {
    peaky[index] = 0.9 * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE);
  }
  const worse = compareToFloor({
    floor: floorFrom(reference),
    subject: subjectOf(reference, peaky),
  });
  assert.equal(standingOf(worse, "peak"), "worse");
  assert.match(worse.summary, /worse on peak/);
  assert.match(worse.summary, /headroom/);

  const better = compareToFloor({
    floor: floorFrom(reference),
    subject: subjectOf(reference, scaled(reference, 0.9)),
  });
  assert.equal(standingOf(better, "peak"), "better");
});

test("a silent subject is never passed: unmeasured axes are named", () => {
  const reference = tone(2, 220, 0.4);
  const comparison = compareToFloor({
    floor: floorFrom(reference),
    subject: subjectOf(reference, new Array(2 * SAMPLE_RATE).fill(0)),
  });

  assert.equal(comparison.verdict, "fail");
  assert.equal(standingOf(comparison, "level"), "unmeasured");
  assert.match(comparison.summary, /not measured on level/);
  assert.match(comparison.summary, /worse on distortion/);
});

test("an axis the format cannot carry is inconclusive, never a pass", () => {
  // An 8 kHz delivered file cannot be residual-compared with a 24 kHz
  // reference, so distortion is unknown and the subject does not clear.
  const reference = tone(2, 220, 0.4);
  const comparison = compareToFloor({
    floor: floorFrom(reference),
    subject: {
      reference: { path: "/captures/reference.wav", audio: decode(reference) },
      delivered: {
        path: "/captures/delivered-8khz.wav",
        audio: decode(tone(2, 220, 0.4, 8_000), 8_000),
      },
    },
  });

  assert.equal(comparison.verdict, "inconclusive");
  assert.equal(standingOf(comparison, "distortion"), "unmeasured");
  assert.deepEqual(comparison.worse, []);
  assert.match(comparison.summary, /INCONCLUSIVE/);
  assert.match(comparison.summary, /not measured on distortion/);
  assert.match(comparison.summary, /format/);
});

test("a copy of the committed floor clears it, and the floor is cited by path", () => {
  const floor = loadVendorFloor();
  const comparison = compareToFloor({
    floor,
    subject: {
      reference: { path: "reference", audio: floor.audio },
      delivered: { path: "delivered", audio: floor.audio },
    },
  });

  assert.equal(comparison.verdict, "pass");
  assert.match(comparison.summary, new RegExp(floor.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(comparison.summary, /2026-10-29/);
  // The committed floor's own measured baseline is what the subject matched.
  assert.match(comparison.summary, /-20\.\d\d LUFS/);
});

test("the floor verdict prints its axes, the floor path and one verdict", () => {
  const reference = tone(2, 220, 0.4);
  const comparison = compareToFloor({
    floor: floorFrom(reference),
    subject: subjectOf(reference, tone(2, 220, 0.3)),
  });
  const text = formatFloorVerdict(comparison);

  assert.match(text, /floor\s+anna\/en at \/evidence\/vendor-floor\/anna-en\.wav/);
  assert.match(text, /reference\s+\/captures\/reference\.wav/);
  assert.match(text, /subject\s+\/captures\/delivered\.wav/);
  assert.match(text, /level\s+worse/);
  assert.match(text, /peak\s+\w+/);
  assert.match(text, /verdict\s+FAIL/);
  assert.match(text, /worse on level/);
});

test("the same floor and subject produce the same verdict twice", () => {
  const reference = tone(2, 220, 0.4);
  const floor = floorFrom(reference);
  const subject = subjectOf(reference, tone(2, 220, 0.3));
  const first = compareToFloor({ floor, subject });
  const second = compareToFloor({ floor, subject });

  assert.equal(formatFloorVerdict(first), formatFloorVerdict(second));
  assert.deepEqual(
    first.axes.map((axis) => axis.axis),
    ["level", "peak", "distortion", "breakups", "modulation"],
  );
});
