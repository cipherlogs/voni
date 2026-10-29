/**
 * W0 verdict layers (ticket 124).
 *
 * The verdict names the first layer that diverged, in causal order: the
 * vendor's voice, the model's text, our pipeline, or the client. A later
 * difference cannot steal the blame, and a model-text mismatch means the audio
 * layers were never comparable.
 *
 * Every case builds its own WAVs: the expected layer comes from the signal (a
 * known level step, a known harmonic, a known hole, a known fold), never from
 * the verdict module's own reading.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decodeWav, type DecodedAudio } from "./format-facts";
import {
  compareReferenceAndDelivered,
  type TwoCaptureComparison,
  type TwoCaptureSlot,
} from "./comparison";
import {
  W0_AUDIO_METRICS,
  W0_LAYERS,
  decideW0Verdict,
  type W0Check,
  type W0LayerFinding,
  type W0Metric,
  type W0Verdict,
} from "./w0-verdict";

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

/** Speak, hold digitally silent, speak again: the hole a starved buffer leaves. */
function toneWithHole(seconds = 0.4, hole = 0.5, hz = 180, amplitude = 0.35): number[] {
  return [
    ...tone(seconds, hz, amplitude),
    ...silence(hole),
    ...tone(seconds, hz, amplitude),
    ...tone(seconds, hz, amplitude),
  ];
}

/** A 60 ms gain dip that never reaches silence: the playout's boundary fade. */
function faded(samples: number[], atSeconds = 0.5, depthDb = -6, fadeSeconds = 0.06): number[] {
  const start = Math.round(atSeconds * SAMPLE_RATE);
  const length = Math.round(fadeSeconds * SAMPLE_RATE);
  const floor = 10 ** (depthDb / 20);
  return samples.map((sample, index) => {
    if (index < start || index >= start + length) return sample;
    const position = (index - start) / length;
    const gain = 1 - (1 - floor) * Math.sin(Math.PI * position);
    return sample * gain;
  });
}

const GREETING = {
  kind: "greeting" as const,
  text: "Hi, I'm Voni! Let's try something cool.",
};

function decoded(bytes: Buffer): DecodedAudio {
  return decodeWav(bytes);
}

function slot(bytes: Buffer, path: string): TwoCaptureSlot {
  return { path, audio: decoded(bytes) };
}

function comparisonFor(
  reference: Buffer | null,
  delivered: Buffer | null,
): TwoCaptureComparison {
  return compareReferenceAndDelivered({
    reference: reference === null ? null : slot(reference, "/captures/reference.wav"),
    delivered: delivered === null ? null : slot(delivered, "/captures/delivered.wav"),
    line: GREETING,
  });
}

function verdictFor(
  reference: Buffer | null,
  delivered: Buffer | null,
  extra: {
    transcript?: string;
    intent?: { voice?: string; language?: string };
    delivered?: { voice?: string; language?: string };
  } = {},
): W0Verdict {
  return decideW0Verdict({
    comparison: comparisonFor(reference, delivered),
    transcript: extra.transcript,
    intent: extra.intent,
    delivered: extra.delivered,
  });
}

function layer(verdict: W0Verdict, name: (typeof W0_LAYERS)[number]): W0LayerFinding {
  const found = verdict.layers.find((candidate) => candidate.layer === name);
  assert.ok(found, `the verdict reports the ${name} layer`);
  return found;
}

function check(verdict: W0Verdict, metric: W0Metric, subject: W0Check["subject"] = "delivered"): W0Check {
  const found = verdict.checks.find(
    (candidate) => candidate.metric === metric && candidate.subject === subject,
  );
  assert.ok(found, `the verdict evaluated the ${subject} ${metric} check`);
  return found;
}

const MATCHING_TRANSCRIPT = GREETING.text;

test("the four layers are reported in causal order", () => {
  const line = wavFrom(tone(1, 500, 0.4));
  const verdict = verdictFor(line, line, { transcript: MATCHING_TRANSCRIPT });

  assert.deepEqual(
    verdict.layers.map((entry) => entry.layer),
    [...W0_LAYERS],
  );
  assert.equal(verdict.status, "none");
  assert.equal(verdict.layer, null);
  for (const entry of verdict.layers) {
    assert.equal(entry.status, "PASS", `${entry.layer}: ${entry.reason}`);
  }
});

test("a level step names our pipeline, and a hole in the same capture cannot steal the blame", () => {
  const steady = tone(2, 1_000, 0.4);
  const quiet = tone(2, 1_000, 0.2);
  const damaged = [
    ...quiet.slice(0, 12_000),
    ...silence(0.4),
    ...quiet.slice(12_000),
  ].map((sample, index) => sample * (1 + 0.5 * Math.sin((2 * Math.PI * 20 * index) / SAMPLE_RATE)));

  const verdict = verdictFor(wavFrom(steady), wavFrom(damaged), {
    transcript: MATCHING_TRANSCRIPT,
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "our pipeline");
  assert.equal(verdict.axis, "level");
  assert.match(verdict.sentence, /^The first divergence is our pipeline:/);
  assert.ok(check(verdict, "level").status === "FAIL");
  for (const name of ["client"] as const) {
    assert.equal(layer(verdict, name).status, "NOT-COMPARABLE");
  }
});

test("a model-text mismatch names model text and the audio layers were never comparable", () => {
  const line = wavFrom(tone(1, 500, 0.4));
  const verdict = verdictFor(line, line, {
    transcript: "Your appointment is at nine o'clock.",
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "model text");
  assert.equal(verdict.axis, null);
  assert.match(verdict.sentence, /^The first divergence is model text:/);
  assert.match(verdict.sentence, /never given the same words|cannot be compared/);
  assert.equal(layer(verdict, "our pipeline").status, "NOT-COMPARABLE");
  assert.equal(layer(verdict, "client").status, "NOT-COMPARABLE");
  assert.deepEqual(layer(verdict, "our pipeline").checks, []);
});

test("a missing transcript blocks a pass with a named reason", () => {
  const line = wavFrom(tone(1, 500, 0.4));
  const verdict = verdictFor(line, line);

  assert.equal(verdict.status, "unresolved");
  assert.equal(verdict.layer, null);
  assert.match(verdict.sentence, /^The verdict is unresolved:/);
  assert.match(verdict.blockers.join("; "), /no transcript/i);
});

test("an octave tilt names our pipeline", () => {
  const balanced = tone(1, 500, 0.3).map(
    (sample, index) => sample + 0.3 * Math.sin((2 * Math.PI * 4_000 * index) / SAMPLE_RATE),
  );
  const darker = tone(1, 500, 0.44).map(
    (sample, index) => sample + 0.16 * Math.sin((2 * Math.PI * 4_000 * index) / SAMPLE_RATE),
  );
  const verdict = verdictFor(wavFrom(balanced), wavFrom(darker), {
    transcript: MATCHING_TRANSCRIPT,
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "our pipeline");
  assert.equal(verdict.axis, "spectrum");
  assert.ok(check(verdict, "spectrum").status === "FAIL");
});

test("a third-harmonic residual names our pipeline", () => {
  const clean = tone(1, 440, 0.3);
  const reshaped = clean.map(
    (sample, index) => sample + 0.01 * 0.3 * Math.sin((2 * Math.PI * 3 * 440 * index) / SAMPLE_RATE),
  );
  const verdict = verdictFor(wavFrom(clean), wavFrom(reshaped), {
    transcript: MATCHING_TRANSCRIPT,
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "our pipeline");
  assert.equal(verdict.axis, "distortion");
  assert.ok(check(verdict, "distortion").status === "FAIL");
});

test("a voice difference names our pipeline", () => {
  const line = wavFrom(tone(1, 500, 0.4));
  const verdict = verdictFor(line, line, {
    transcript: MATCHING_TRANSCRIPT,
    intent: { voice: "anna" },
    delivered: { voice: "juergen" },
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "our pipeline");
  assert.equal(verdict.axis, "voice");
  assert.match(verdict.sentence, /juergen/);
});

test("a language difference names our pipeline", () => {
  const line = wavFrom(tone(1, 500, 0.4));
  const verdict = verdictFor(line, line, {
    transcript: MATCHING_TRANSCRIPT,
    intent: { language: "en" },
    delivered: { language: "es" },
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "our pipeline");
  assert.equal(verdict.axis, "language");
});

test("chunk-rate modulation names the client", () => {
  const steady = tone(2, 1_000, 0.4);
  const modulated = steady.map(
    (sample, index) => sample * (1 + 0.5 * Math.sin((2 * Math.PI * 20 * index) / SAMPLE_RATE)),
  );
  const verdict = verdictFor(wavFrom(steady), wavFrom(modulated), {
    transcript: MATCHING_TRANSCRIPT,
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "client");
  assert.equal(verdict.axis, "modulation");
  assert.match(verdict.sentence, /^The first divergence is the client:/);
  assert.ok(check(verdict, "modulation").status === "FAIL");
});

test("an inserted silence names the client, not a pipeline residual", () => {
  const continuous = tone(1.7, 180, 0.35);
  const verdict = verdictFor(wavFrom(continuous), wavFrom(toneWithHole()), {
    transcript: MATCHING_TRANSCRIPT,
  });

  assert.equal(verdict.status, "divergence", verdict.blockers.join("; "));
  assert.equal(verdict.layer, "client");
  assert.equal(verdict.axis, "breakups");
  assert.ok(check(verdict, "breakups").status === "FAIL");
  assert.equal(check(verdict, "distortion").status, "PASS", "the hole is not a server-side residual");
});

test("a device-rate alias names the client", () => {
  // 11 kHz survives a 24 kHz capture; at a 16 kHz device rate it folds to
  // 5 kHz. The delivered file carries the folded tone lower where the
  // reference had none, and loses the high band it had: a fold, not a tilt.
  const high = tone(1, 11_000, 0.4);
  const folded = tone(1, 5_000, 0.4);
  const verdict = verdictFor(wavFrom(high), wavFrom(folded), {
    transcript: MATCHING_TRANSCRIPT,
  });

  assert.equal(verdict.status, "divergence", verdict.blockers.join("; "));
  assert.equal(verdict.layer, "client");
  assert.equal(verdict.axis, "alias");
  assert.ok(check(verdict, "alias").status === "FAIL");
});

test("a boundary fade names the client", () => {
  const steady = tone(1, 1_000, 0.4);
  const verdict = verdictFor(wavFrom(steady), wavFrom(faded(steady)), {
    transcript: MATCHING_TRANSCRIPT,
  });

  assert.equal(verdict.status, "divergence", verdict.blockers.join("; "));
  assert.equal(verdict.layer, "client");
  assert.equal(verdict.axis, "fade");
  assert.ok(check(verdict, "fade").status === "FAIL");
});

test("a reference at the true-peak ceiling names the vendor voice", () => {
  const clipped = tone(1, 500, 1);
  const verdict = verdictFor(wavFrom(clipped), wavFrom(tone(1, 500, 0.3)), {
    transcript: MATCHING_TRANSCRIPT,
  });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "vendor voice");
  assert.match(verdict.sentence, /^The first divergence is the vendor voice:/);
  assert.match(verdict.sentence, /ceiling/);
});

test("a reference with an inserted silence names the vendor voice", () => {
  const broken = wavFrom(toneWithHole());
  const verdict = verdictFor(broken, broken, { transcript: MATCHING_TRANSCRIPT });

  assert.equal(verdict.status, "divergence");
  assert.equal(verdict.layer, "vendor voice");
  assert.match(verdict.sentence, /inserted silence/);
});

test("a missing reference is unresolved, not a vendor-voice accusation", () => {
  const delivered = wavFrom(tone(1, 500, 0.3));
  const verdict = verdictFor(null, delivered, { transcript: MATCHING_TRANSCRIPT });

  assert.equal(verdict.status, "unresolved");
  assert.equal(verdict.layer, null);
  assert.match(verdict.blockers.join("; "), /reference capture missing/);
  assert.notEqual(layer(verdict, "vendor voice").status, "FAIL");
});

test("every audio metric is represented by a check the verdict evaluated", () => {
  const line = wavFrom(tone(1, 500, 0.4));
  const verdict = verdictFor(line, line, { transcript: MATCHING_TRANSCRIPT });
  const evaluated = new Set(
    verdict.checks.filter((entry) => entry.subject === "delivered").map((entry) => entry.metric),
  );

  for (const metric of W0_AUDIO_METRICS) {
    assert.ok(evaluated.has(metric), `the delivered ${metric} check was evaluated`);
  }
});
