/**
 * Distortion and crest factor for a delivered recording, measured against the
 * reference rendering of the same line.
 *
 * Both metrics read the `DecodedAudio` seam (`facts` plus interleaved 16-bit
 * `samples`) so a saved call can be re-analysed with no browser, network or
 * second decoder.
 *
 * - **Distortion residual** is what is left of the delivered signal once the
 *   reference, at its best-fit gain, is subtracted. Gain is fitted per channel
 *   because a level difference is a different metric; a residual therefore
 *   reports reshaping and clipping, not loudness.
 * - **Crest factor** is peak over RMS. A squared-off copy collapses to 1.0
 *   while clean speech stays well above it.
 *
 * Every check names its metric and reports INFO, never PASS, when the signal
 * makes it unmeasurable.
 */
import type { DecodedAudio } from "./format-facts";

/** Full-scale int16, the reference every level is quoted against. */
const FULL_SCALE = 32_768;

export type DistortionCrestThresholds = {
  /** Highest acceptable residual, in dB relative to the fitted reference RMS. */
  maxResidualDb: number;
  /** Lowest acceptable crest factor (peak / RMS). */
  minCrestFactor: number;
};

/**
 * A 1% third harmonic sits at -40 dB, 20 dB above this line, and an exact copy
 * reports -Infinity, so the threshold separates a clean file from a reshaped
 * one with margin on both sides. Crest 1.2 sits between a square wave (1.0)
 * and a sine (1.414), the lowest crest a clean voiced signal can show.
 */
export const DEFAULT_DISTORTION_CREST_THRESHOLDS: DistortionCrestThresholds = {
  maxResidualDb: -60,
  minCrestFactor: 1.2,
};

export type MetricName = "distortion-residual" | "crest-factor";

export type MetricVerdict = "pass" | "fail" | "info";

export type MetricCheck = {
  metric: MetricName;
  /** Measured value; `null` when the signal cannot carry the metric. */
  measured: number | null;
  threshold: number;
  verdict: MetricVerdict;
  /** A readable sentence naming the metric, the measurement and the bar. */
  detail: string;
};

export type DistortionResidual = {
  /** Worst channel's residual RMS in dB; -Infinity for an exact copy. */
  residualDb: number;
  /** Worst channel's residual RMS, in full-scale units. */
  residualRms: number;
  /** Worst channel's own reference RMS, before gain fitting. */
  referenceRms: number;
  /** Least-squares gain that best maps the reference onto the delivered signal. */
  gain: number;
  /** Frames of the reference with no delivered sample behind them. */
  missingFrames: number;
  /** The channel that produced `residualDb`. */
  worstChannel: number;
  /** Per-channel residual in dB, in channel order. */
  channelResidualsDb: number[];
};

export type CrestFactor = {
  /** The channel that produced `crestFactor`. */
  worstChannel: number;
  /** Peak absolute sample on the worst channel. */
  peak: number;
  /** RMS on the worst channel. */
  rms: number;
  /** peak / RMS on the worst channel; 1.0 for a square wave. */
  crestFactor: number;
  /** Per-channel crest factor, in channel order. */
  channelCrestFactors: number[];
};

export type DistortionCrestReport = {
  distortion: DistortionResidual;
  crest: CrestFactor;
  checks: MetricCheck[];
  /** Only the checks that failed, each naming its own metric. */
  failures: MetricCheck[];
  verdict: MetricVerdict;
  /** One sentence: the named failures, or that both metrics are within bar. */
  summary: string;
};

/** A signal the metric cannot be computed from, named rather than guessed. */
export class DistortionCrestError extends Error {
  constructor(
    readonly code: "format-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "DistortionCrestError";
  }
}

/**
 * Residual of `delivered` against `reference` after subtracting the best-fit
 * gain of the reference. Every frame of the longer file is counted, so a
 * delivered file that ends early or runs long is penalised rather than
 * silently trimmed to the overlap.
 */
export function distortionResidual(
  reference: DecodedAudio,
  delivered: DecodedAudio,
): DistortionResidual {
  if (
    reference.facts.sampleRate !== delivered.facts.sampleRate ||
    reference.facts.channels !== delivered.facts.channels
  ) {
    throw new DistortionCrestError(
      "format-mismatch",
      `Reference is ${reference.facts.sampleRate} Hz x ${reference.facts.channels}ch and ` +
        `delivered is ${delivered.facts.sampleRate} Hz x ${delivered.facts.channels}ch; ` +
        "resample or refuse, never guess.",
    );
  }
  const { channels } = reference.facts;
  const referenceFrames = reference.facts.frameCount;
  const deliveredFrames = delivered.facts.frameCount;
  const frames = Math.max(referenceFrames, deliveredFrames);
  const channelResidualsDb: number[] = [];
  let worstChannel = 0;
  let worstRms = 0;
  let worstReferenceRms = 0;
  let worstGain = 0;

  for (let channel = 0; channel < channels; channel++) {
    let gainNumerator = 0;
    let referenceSquares = 0;
    for (let frame = 0; frame < referenceFrames; frame++) {
      const r = reference.samples[frame * channels + channel] / FULL_SCALE;
      const d =
        frame < deliveredFrames ? delivered.samples[frame * channels + channel] / FULL_SCALE : 0;
      gainNumerator += r * d;
      referenceSquares += r * r;
    }
    const gain = referenceSquares > 0 ? gainNumerator / referenceSquares : 0;
    let residualSquares = 0;
    for (let frame = 0; frame < frames; frame++) {
      const r = frame < referenceFrames ? reference.samples[frame * channels + channel] / FULL_SCALE : 0;
      const d =
        frame < deliveredFrames ? delivered.samples[frame * channels + channel] / FULL_SCALE : 0;
      const residual = d - gain * r;
      residualSquares += residual * residual;
    }
    const residualRms = Math.sqrt(residualSquares / frames);
    const referenceRms = Math.sqrt(referenceSquares / referenceFrames);
    const scale = Math.abs(gain) * referenceRms;
    const db =
      referenceRms <= 0
        ? -Infinity
        : scale <= 0
          ? Infinity
          : residualRms <= 0
            ? -Infinity
            : 20 * Math.log10(residualRms / scale);
    channelResidualsDb.push(db);
    if (channel === 0 || db > channelResidualsDb[worstChannel]) {
      worstChannel = channel;
      worstRms = residualRms;
      worstReferenceRms = referenceRms;
      worstGain = gain;
    }
  }

  return {
    residualDb: channelResidualsDb[worstChannel],
    residualRms: worstRms,
    referenceRms: worstReferenceRms,
    gain: worstGain,
    missingFrames: Math.max(0, referenceFrames - deliveredFrames),
    worstChannel,
    channelResidualsDb,
  };
}

/** Peak over RMS per channel, reported at its worst (lowest) channel. */
export function crestFactor(audio: DecodedAudio): CrestFactor {
  const { channels } = audio.facts;
  const channelCrestFactors: number[] = [];
  const peaks: number[] = [];
  const rmsValues: number[] = [];
  let worstChannel = -1;

  for (let channel = 0; channel < channels; channel++) {
    let peak = 0;
    let sumSquares = 0;
    let count = 0;
    for (let i = channel; i < audio.samples.length; i += channels) {
      const value = audio.samples[i] / FULL_SCALE;
      peak = Math.max(peak, Math.abs(value));
      sumSquares += value * value;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
    const factor = rms > 0 ? peak / rms : Number.NaN;
    peaks.push(peak);
    rmsValues.push(rms);
    channelCrestFactors.push(factor);
    if (
      worstChannel < 0 ||
      (Number.isFinite(factor) &&
        (!Number.isFinite(channelCrestFactors[worstChannel]) ||
          factor < channelCrestFactors[worstChannel]))
    ) {
      worstChannel = channel;
    }
  }

  if (worstChannel < 0) worstChannel = 0;
  return {
    worstChannel,
    peak: peaks[worstChannel],
    rms: rmsValues[worstChannel],
    crestFactor: channelCrestFactors[worstChannel],
    channelCrestFactors: channelCrestFactors,
  };
}

/** Percent-free dB text: an exact copy reads "no residual", not "-Infinity dB". */
function dbText(db: number): string {
  if (db === -Infinity) return "no residual";
  if (db === Infinity) return "no delivered signal";
  return `${db.toFixed(1)} dB`;
}

function distortionCheck(
  residual: DistortionResidual,
  thresholds: DistortionCrestThresholds,
): MetricCheck {
  if (!(residual.referenceRms > 0)) {
    return {
      metric: "distortion-residual",
      measured: null,
      threshold: thresholds.maxResidualDb,
      verdict: "info",
      detail: "reference is silent, so there is no signal to compare against.",
    };
  }
  const measured = residual.residualDb;
  const passed = measured <= thresholds.maxResidualDb;
  return {
    metric: "distortion-residual",
    measured,
    threshold: thresholds.maxResidualDb,
    verdict: passed ? "pass" : "fail",
    detail: `${dbText(measured)} against the reference, ${
      passed ? "within" : "above"
    } the ${thresholds.maxResidualDb} dB bar.`,
  };
}

function crestCheck(crest: CrestFactor, thresholds: DistortionCrestThresholds): MetricCheck {
  if (!Number.isFinite(crest.crestFactor)) {
    return {
      metric: "crest-factor",
      measured: null,
      threshold: thresholds.minCrestFactor,
      verdict: "info",
      detail: "delivered signal is silent, so it has no crest factor.",
    };
  }
  const measured = crest.crestFactor;
  const passed = measured >= thresholds.minCrestFactor;
  return {
    metric: "crest-factor",
    measured,
    threshold: thresholds.minCrestFactor,
    verdict: passed ? "pass" : "fail",
    detail: `${measured.toFixed(3)} peak/RMS on channel ${crest.worstChannel}, ${
      passed ? "at or above" : "below"
    } the ${thresholds.minCrestFactor} bar.`,
  };
}

/** Both metrics, each with a named verdict, plus an overall verdict. */
export function measureDistortionAndCrest(
  reference: DecodedAudio,
  delivered: DecodedAudio,
  thresholds: DistortionCrestThresholds = DEFAULT_DISTORTION_CREST_THRESHOLDS,
): DistortionCrestReport {
  const distortion = distortionResidual(reference, delivered);
  const crest = crestFactor(delivered);
  const checks = [distortionCheck(distortion, thresholds), crestCheck(crest, thresholds)];
  const failures = checks.filter((entry) => entry.verdict === "fail");
  const verdict: MetricVerdict =
    failures.length > 0 ? "fail" : checks.some((entry) => entry.verdict === "info") ? "info" : "pass";
  // A metric the signal cannot carry is INFO, never PASS, and the summary says so.
  const summary =
    failures.length > 0
      ? failures.map((entry) => `FAIL ${entry.metric}: ${entry.detail}`).join("; ")
      : verdict === "info"
        ? checks
            .filter((entry) => entry.verdict === "info")
            .map((entry) => `INFO ${entry.metric}: ${entry.detail}`)
            .join("; ")
        : "PASS distortion-residual and crest-factor are within bar.";
  return {
    distortion,
    crest,
    checks,
    failures,
    verdict,
    summary,
  };
}
