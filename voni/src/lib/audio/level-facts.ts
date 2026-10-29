/**
 * Level facts for one recording: how loud it is, and how close its loudest
 * moment comes to full scale.
 *
 * Two levels, because they answer different questions:
 *
 * - **Integrated loudness** is ITU-R BS.1770-4 / EBU R128: K-weighted 400 ms
 *   blocks every 100 ms, with the absolute (-70 LUFS) and relative (-10 LU)
 *   gates. A quiet passage is discarded rather than averaged in, which is what
 *   makes it "integrated" rather than a mean.
 * - **RMS** is the plain power average of the whole recording, so the two
 *   numbers disagree exactly when the recording is uneven. Both are power
 *   sums across channels, so a channel added or lost cannot pass as a level
 *   change.
 *
 * **True peak** is estimated by 4x oversampling with a windowed-sinc
 * interpolator, so a peak that falls between samples is measured instead of
 * missed. The interpolated values are only trusted where the whole filter
 * support sits inside the file; the boundary is sample-peak territory, since
 * nothing outside the capture is known.
 *
 * A recording with no measurable level reports `measured: false` and a named
 * reason, with every number `null`. It never reports a small number that a
 * reader could mistake for a measurement.
 *
 * The module is pure — decoded audio in, facts out — so a saved file can be
 * re-analysed without a browser, network or database.
 */
import type { DecodedAudio } from "./format-facts";

/**
 * Two readings within this are the same level. EBU Tech 3341 states ±0.1 LU
 * for a static conformance tone at 48 kHz; 16-bit captures and the K-weighting
 * fit at the lower rates our sessions use need the extra tenth.
 */
export const LEVEL_TOLERANCE_DB = 0.2;

/**
 * A 4x oversampled true peak estimates the waveform peak; BS.1770-4's own
 * interpolation is an estimate too, so a third of a decibel is the resolution
 * the number actually has.
 */
export const TRUE_PEAK_TOLERANCE_DB = 0.3;

/** One 16-bit LSB is -90.3 dBFS; a capture this quiet carries no level. */
export const SILENCE_PEAK_DBFS = -90;

const FULL_SCALE = 32_768;

const BLOCK_SECONDS = 0.4;
const HOP_SECONDS = 0.1;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
/** The offset BS.1770 places on a mean-square power to read LUFS. */
const LOUDNESS_OFFSET = -0.691;

/** Halves of the interpolation kernel kept on each side of the sample. */
const TRUE_PEAK_TAPS = 16;
const TRUE_PEAK_PHASES = 3;

/** No level was measurable, and why. */
export type LevelAbsenceReason = "digital-silence" | "too-short" | "below-gate";

type AbsentLevelFacts = {
  measured: false;
  absence: LevelAbsenceReason;
  integratedLufs: null;
  rmsDbfs: null;
  samplePeakDbfs: null;
  truePeakDbtp: null;
};

type MeasuredLevelFacts = {
  measured: true;
  absence: null;
  /** Gated integrated loudness, LUFS (BS.1770-4). */
  integratedLufs: number;
  /** Whole-recording power average, dBFS re full scale. */
  rmsDbfs: number;
  /** Loudest sample, dBFS. */
  samplePeakDbfs: number;
  /** Loudest point of the reconstructed waveform, dBTP. */
  truePeakDbtp: number;
};

export type LevelFacts = MeasuredLevelFacts | AbsentLevelFacts;

export type LevelComparison = {
  /** `unmeasured` is a third state: absence is never agreement. */
  status: "agrees" | "differs" | "unmeasured";
  /** Second reading minus first, in LU. Null unless both sides were measured. */
  deltaLu: number | null;
  /** One sentence naming the measured values, or the absence. */
  detail: string;
};

export type LevelFactsErrorCode = "unsupported-layout" | "invalid-layout";

/** A refused input. A caller can branch on `code`; nothing is guessed. */
export class LevelFactsError extends Error {
  constructor(
    readonly code: LevelFactsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LevelFactsError";
  }
}

/** A second-order section, in the order `ts` needs: b0, b1, b2 / a0, a1, a2. */
type Biquad = { b: readonly number[]; a: readonly number[] };

/**
 * The BS.1770 K-weighting pair for any rate. At 48 kHz these reproduce the
 * coefficients printed in the recommendation; at 24 kHz — the rate our
 * sessions actually deliver — they are re-derived rather than reused, because
 * reusing the 48 kHz pair would misplace the shelf and read a tone loud.
 */
function kWeighting(sampleRate: number): readonly [Biquad, Biquad] {
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfHz = 1681.974450955533;
  const k = Math.tan((Math.PI * shelfHz) / sampleRate);
  const highGain = 10 ** (shelfGainDb / 20);
  const bandGain = highGain ** 0.4996667741545416;
  const shelfDenominator = 1 + k / shelfQ + k * k;
  const shelf: Biquad = {
    b: [
      (highGain + (bandGain * k) / shelfQ + k * k) / shelfDenominator,
      (2 * (k * k - highGain)) / shelfDenominator,
      (highGain - (bandGain * k) / shelfQ + k * k) / shelfDenominator,
    ],
    a: [
      1,
      (2 * (k * k - 1)) / shelfDenominator,
      (1 - k / shelfQ + k * k) / shelfDenominator,
    ],
  };

  const highPassQ = 0.5003270373238773;
  const highPassHz = 38.13547087602444;
  const h = Math.tan((Math.PI * highPassHz) / sampleRate);
  const highPassDenominator = 1 + h / highPassQ + h * h;
  const highPass: Biquad = {
    b: [1 / highPassDenominator, -2 / highPassDenominator, 1 / highPassDenominator],
    a: [
      1,
      (2 * (h * h - 1)) / highPassDenominator,
      (1 - h / highPassQ + h * h) / highPassDenominator,
    ],
  };

  return [shelf, highPass];
}

function biquad(input: Float64Array, section: Biquad): Float64Array {
  const output = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < input.length; index++) {
    const x = input[index];
    const y =
      section.b[0] * x +
      section.b[1] * x1 +
      section.b[2] * x2 -
      section.a[1] * y1 -
      section.a[2] * y2;
    output[index] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return output;
}

function db(amplitude: number): number {
  return 20 * Math.log10(amplitude);
}

function deinterleave(samples: Int16Array, channels: number): Float64Array[] {
  const frames = samples.length / channels;
  return Array.from({ length: channels }, (_, channel) => {
    const out = new Float64Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      out[frame] = samples[frame * channels + channel] / FULL_SCALE;
    }
    return out;
  });
}

function meanSquare(channel: Float64Array, start: number, length: number): number {
  let sum = 0;
  for (let index = start; index < start + length; index++) {
    sum += channel[index] * channel[index];
  }
  return sum / length;
}

function totalMeanSquare(channels: readonly Float64Array[]): number {
  let power = 0;
  for (const channel of channels) power += meanSquare(channel, 0, channel.length);
  return power;
}

type GatedLoudness =
  | { kind: "measured"; lufs: number }
  | { kind: "too-short" }
  | { kind: "below-gate" };

function gatedLoudness(
  channels: readonly Float64Array[],
  sampleRate: number,
): GatedLoudness {
  const block = Math.round(BLOCK_SECONDS * sampleRate);
  const hop = Math.round(HOP_SECONDS * sampleRate);
  const frames = channels[0]?.length ?? 0;
  if (frames < block) return { kind: "too-short" };

  const [shelf, highPass] = kWeighting(sampleRate);
  const weighted = channels.map((channel) => biquad(biquad(channel, shelf), highPass));

  const loudness = (power: number) => LOUDNESS_OFFSET + 10 * Math.log10(power);
  const blockPowers: number[] = [];
  for (let start = 0; start + block <= frames; start += hop) {
    let power = 0;
    for (const channel of weighted) power += meanSquare(channel, start, block);
    blockPowers.push(power);
  }

  const audible = blockPowers.filter(
    (power) => power > 0 && loudness(power) > ABSOLUTE_GATE_LUFS,
  );
  if (audible.length === 0) return { kind: "below-gate" };

  const ungated = audible.reduce((sum, power) => sum + power, 0) / audible.length;
  const relativeGate = loudness(ungated) + RELATIVE_GATE_LU;
  const gated = audible.filter((power) => loudness(power) > relativeGate);
  if (gated.length === 0) return { kind: "below-gate" };

  return {
    kind: "measured",
    lufs: loudness(gated.reduce((sum, power) => sum + power, 0) / gated.length),
  };
}

/**
 * One interpolation kernel per fractional phase, DC-normalised so a constant
 * signal interpolates to itself. Blackman-windowed sinc: flat to the top of
 * the band and far enough down to not invent a peak.
 */
function interpolationKernels(): Float64Array[] {
  return Array.from({ length: TRUE_PEAK_PHASES }, (_, phase) => {
    const fraction = (phase + 1) / (TRUE_PEAK_PHASES + 1);
    const kernel = new Float64Array(2 * TRUE_PEAK_TAPS + 1);
    for (let index = 0; index < kernel.length; index++) {
      const offset = index - TRUE_PEAK_TAPS + fraction;
      const sinc =
        offset === 0 ? 1 : Math.sin(Math.PI * offset) / (Math.PI * offset);
      const window =
        0.42 +
        0.5 * Math.cos((Math.PI * offset) / (TRUE_PEAK_TAPS + 1)) +
        0.08 * Math.cos((2 * Math.PI * offset) / (TRUE_PEAK_TAPS + 1));
      kernel[index] = sinc * window;
    }
    const gain = kernel.reduce((sum, value) => sum + value, 0);
    for (let index = 0; index < kernel.length; index++) kernel[index] /= gain;
    return kernel;
  });
}

function oversampledPeak(channels: readonly Float64Array[]): number {
  const kernels = interpolationKernels();
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
    for (let index = TRUE_PEAK_TAPS; index < channel.length - TRUE_PEAK_TAPS; index++) {
      for (const kernel of kernels) {
        let value = 0;
        for (let tap = 0; tap < kernel.length; tap++) {
          value += channel[index - TRUE_PEAK_TAPS + tap] * kernel[tap];
        }
        peak = Math.max(peak, Math.abs(value));
      }
    }
  }
  return peak;
}

function absent(reason: LevelAbsenceReason): AbsentLevelFacts {
  return {
    measured: false,
    absence: reason,
    integratedLufs: null,
    rmsDbfs: null,
    samplePeakDbfs: null,
    truePeakDbtp: null,
  };
}

/**
 * Measure one decoded recording. Channels are summed the way BS.1770 sums
 * them, so mono and dual-mono stereo differ by 3 dB rather than by nothing.
 */
export function analyseLevel(audio: DecodedAudio): LevelFacts {
  const { channels: channelCount, sampleRate } = audio.facts;
  if (channelCount < 1 || channelCount > 2) {
    throw new LevelFactsError(
      "unsupported-layout",
      `Level facts weigh one or two channels; the file declares ${channelCount}.`,
    );
  }
  if (audio.samples.length % channelCount !== 0) {
    throw new LevelFactsError(
      "invalid-layout",
      `${audio.samples.length} samples do not divide into ${channelCount} channels.`,
    );
  }
  if (audio.samples.length === 0) return absent("too-short");

  const channels = deinterleave(audio.samples, channelCount);
  let samplePeak = 0;
  for (const channel of channels) {
    for (const sample of channel) samplePeak = Math.max(samplePeak, Math.abs(sample));
  }
  if (samplePeak <= 10 ** (SILENCE_PEAK_DBFS / 20)) return absent("digital-silence");

  const loudness = gatedLoudness(channels, sampleRate);
  if (loudness.kind !== "measured") return absent(loudness.kind);

  return {
    measured: true,
    absence: null,
    integratedLufs: loudness.lufs,
    rmsDbfs: 10 * Math.log10(totalMeanSquare(channels)),
    samplePeakDbfs: db(samplePeak),
    truePeakDbtp: db(oversampledPeak(channels)),
  };
}

/**
 * Compare two level readings. Absence is reported as `unmeasured`, never as
 * agreement: an unmeasured input is not evidence that two files match.
 */
export function compareLevels(
  first: LevelFacts,
  second: LevelFacts,
  toleranceDb: number = LEVEL_TOLERANCE_DB,
): LevelComparison {
  if (!first.measured || !second.measured) {
    const absences = [
      first.measured ? null : `first is ${first.absence}`,
      second.measured ? null : `second is ${second.absence}`,
    ].filter((value): value is string => value !== null);
    return {
      status: "unmeasured",
      deltaLu: null,
      detail: `level unmeasured: ${absences.join(" and ")}`,
    };
  }

  const delta = second.integratedLufs - first.integratedLufs;
  const detail =
    Math.abs(delta) <= toleranceDb
      ? `level agrees within ${toleranceDb.toFixed(2)} LU: ` +
        `${first.integratedLufs.toFixed(2)} LUFS vs ${second.integratedLufs.toFixed(2)} LUFS ` +
        `(${Math.abs(delta).toFixed(2)} LU)`
      : `level differs by ${Math.abs(delta).toFixed(2)} LU: ` +
        `${first.integratedLufs.toFixed(2)} LUFS vs ${second.integratedLufs.toFixed(2)} LUFS, ` +
        `over the ${toleranceDb.toFixed(2)} LU tolerance`;

  return {
    status: Math.abs(delta) <= toleranceDb ? "agrees" : "differs",
    deltaLu: delta,
    detail,
  };
}
