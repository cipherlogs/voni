/**
 * The delivered capture against the committed voice reference.
 *
 * A3, A5 and A8 need the same two things: the delivered greeting aligned to the
 * reference line, and the six measured timbre axes on that pair. Alignment
 * starts each file at its own audible onset and then refines the pair onto the
 * same samples by cross-correlation, so a lead-in — or a gain that moved the
 * onset frame — is a reported fact rather than a timbre difference; a delivered
 * line too short to hold the reference is a refusal, never a quietly shortened
 * measurement.
 *
 * The axes are the existing `measureTimbre` result (voice-parity ticket 74),
 * not a second implementation. A3's level and modulation legs are measured on
 * the same aligned pair, so the level bar and the pumping bar describe one
 * delivery.
 */

import { analyseLevel } from "@/lib/audio/level-facts";
import { measureEnvelopeModulation } from "@/lib/audio/envelope-modulation";
import type { DecodedAudio } from "@/lib/audio/format-facts";
import {
  BREAKUP_MATCH_SECONDS,
  measureTimbre,
  type MeasuredTimbreResult,
} from "@/lib/demo/timbre-measurement";

import { frameLevelsDb } from "./analysis";

/** A frame above this starts the line; the comparison's own onset floor. */
const ONSET_FLOOR_DBFS = -40;
/** How far the delivered line may be short and still be compared. */
const TRUNCATION_TOLERANCE_S = 0.05;
/**
 * The window the fine alignment searches. The onset is found on a 10 ms frame
 * grid, and a capture loud enough for its lead-in noise to cross the onset
 * floor is onseted at that noise — up to the reference line's own lead-in
 * (0.2 s) away from the speech. A residual measured across that offset is the
 * offset, not distortion: a bit-identical copy delivered 5 ms late measures
 * ~21 dB. The window is one lead-in wide plus the onset frame.
 */
const ALIGN_SEARCH_S = 0.25;
/** The head of the line is the probe the lag is found on. */
const ALIGN_PROBE_S = 1.5;
/** Coarse-to-fine steps for the lag search, in samples. */
const ALIGN_COARSE_STEP = 16;
/** Agreement within this of the peak is a tie, and the smaller lag wins. */
const ALIGN_TIE_TOLERANCE = 0.01;

export type TimbreComparisonErrorCode =
  | "format-mismatch"
  | "no-onset"
  | "truncated"
  | "call-ended"
  | "unmeasured";

/**
 * How the call ended, read from the persisted end document and the capture's
 * own report. A capture that reported itself complete holds every sample the
 * playout rendered; if that is still shorter than the line the pipeline
 * produced, the call ended while audio was queued — not the tap losing a tail.
 */
export type LineEnding = {
  /** `endedBy` as the end document names it (`stop`, `end_call`, ...). */
  readonly endedBy: string | null;
  /** The `delivered_capture` mark's own `complete` report. */
  readonly captureComplete: boolean;
  /** The line the pipeline produced for this delivery, in seconds. */
  readonly producedSeconds: number | null;
};

/** A pair that cannot be compared sample-for-sample, named. */
export class TimbreComparisonError extends Error {
  constructor(
    readonly code: TimbreComparisonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TimbreComparisonError";
  }
}

export type AlignedPair = {
  readonly reference: { readonly path: string; readonly audio: DecodedAudio };
  readonly delivered: { readonly path: string; readonly audio: DecodedAudio };
  /** Delivered onset minus reference onset, in milliseconds. */
  readonly onsetDeltaMs: number;
};

function sliceAudio(audio: DecodedAudio, startFrame: number, frameCount: number): DecodedAudio {
  const channels = audio.facts.channels;
  const start = Math.max(0, Math.min(Math.round(startFrame), audio.facts.frameCount));
  const count = Math.max(0, Math.min(Math.round(frameCount), audio.facts.frameCount - start));
  return {
    samples: audio.samples.subarray(start * channels, (start + count) * channels),
    facts: {
      ...audio.facts,
      dataBytes: count * channels * 2,
      frameCount: count,
      durationSeconds: count / audio.facts.sampleRate,
    },
  };
}

/** The first 10 ms frame above the onset floor, in frames. */
function onsetFrame(audio: DecodedAudio): number | null {
  const levels = frameLevelsDb(audio, 10);
  const frameSamples = Math.max(1, Math.round(audio.facts.sampleRate * 0.01));
  const frame = levels.findIndex((level) => level > ONSET_FLOOR_DBFS);
  return frame < 0 ? null : frame * frameSamples;
}

/**
 * The sample lag at which the delivered line best matches the reference, in
 * [-ALIGN_SEARCH_S, ALIGN_SEARCH_S]. Both slices start at a 10 ms onset frame,
 * so a copy still carries up to a frame of offset — and a gain difference can
 * move the onset frame itself. The lag is found by normalized cross-correlation
 * on the head of the line (channel 0: the channels are coherent), coarsely then
 * at sample resolution, so level is normalised out and only the waveform's
 * agreement moves the peak.
 */
function fineLag(reference: DecodedAudio, delivered: DecodedAudio): number {
  const channels = reference.facts.channels;
  const frames = Math.min(reference.facts.frameCount, delivered.facts.frameCount);
  if (frames <= 0) return 0;
  const probeFrames = Math.min(frames, Math.round(ALIGN_PROBE_S * reference.facts.sampleRate));
  const limit = Math.round(ALIGN_SEARCH_S * reference.facts.sampleRate);
  const stride = Math.max(1, Math.floor(probeFrames / 8000));
  const agreement = (lag: number): number => {
    let dot = 0;
    let referenceSquares = 0;
    let deliveredSquares = 0;
    for (let frame = 0; frame < probeFrames; frame += stride) {
      const other = frame + lag;
      if (other < 0 || other >= delivered.facts.frameCount) continue;
      const r = reference.samples[frame * channels]!;
      const d = delivered.samples[other * channels]!;
      dot += r * d;
      referenceSquares += r * r;
      deliveredSquares += d * d;
    }
    const overlap = referenceSquares * deliveredSquares;
    return overlap > 0 ? dot / Math.sqrt(overlap) : 0;
  };

  let coarse = 0;
  let coarseAgreement = -1;
  for (let lag = -limit; lag <= limit; lag += ALIGN_COARSE_STEP) {
    const value = Math.abs(agreement(lag));
    if (value > coarseAgreement) {
      coarseAgreement = value;
      coarse = lag;
    }
  }
  // A periodic probe agrees at every period, and a tone's agreement says
  // nothing about where the line starts: within the tie band the smallest
  // movement wins, so an aligned pair is left where it is.
  for (let lag = -limit; lag <= limit; lag += ALIGN_COARSE_STEP) {
    if (
      Math.abs(agreement(lag)) >= coarseAgreement - ALIGN_TIE_TOLERANCE &&
      Math.abs(lag) < Math.abs(coarse)
    ) {
      coarse = lag;
    }
  }
  let best = coarse;
  let bestAgreement = Math.abs(agreement(coarse));
  for (let lag = coarse - ALIGN_COARSE_STEP; lag <= coarse + ALIGN_COARSE_STEP; lag += 1) {
    if (lag < -limit || lag > limit) continue;
    const value = Math.abs(agreement(lag));
    if (
      value > bestAgreement + ALIGN_TIE_TOLERANCE ||
      (value >= bestAgreement - ALIGN_TIE_TOLERANCE && Math.abs(lag) < Math.abs(best))
    ) {
      bestAgreement = Math.max(bestAgreement, value);
      best = lag;
    }
  }
  return best;
}

/**
 * Align the delivered line to the reference: each file starts at its own
 * audible onset, then a normalized cross-correlation moves the pair onto the
 * same samples (see {@link fineLag}), so an onset frame or a gain difference is
 * reported as a lead-in rather than measured as distortion. A different rate
 * or channel count is a refusal; so is a delivered line more than 50 ms short
 * of the reference.
 */
export function alignToReference(
  reference: DecodedAudio,
  delivered: DecodedAudio,
  referencePath: string,
  deliveredPath: string,
  ending?: LineEnding,
): AlignedPair {
  if (
    reference.facts.sampleRate !== delivered.facts.sampleRate ||
    reference.facts.channels !== delivered.facts.channels
  ) {
    throw new TimbreComparisonError(
      "format-mismatch",
      `reference ${reference.facts.sampleRate} Hz x${reference.facts.channels}ch and delivered ` +
        `${delivered.facts.sampleRate} Hz x${delivered.facts.channels}ch are not one format; ` +
        "resampling would move the format defect into the measurement",
    );
  }
  const referenceOnset = onsetFrame(reference);
  if (referenceOnset === null) {
    throw new TimbreComparisonError(
      "no-onset",
      `the reference ${referencePath} has no audible onset above ${ONSET_FLOOR_DBFS} dBFS`,
    );
  }
  const deliveredOnset = onsetFrame(delivered);
  if (deliveredOnset === null) {
    throw new TimbreComparisonError(
      "no-onset",
      `the delivered capture ${deliveredPath} has no audible onset above ${ONSET_FLOOR_DBFS} dBFS; ` +
        "a silent delivery is not a timbre pass",
    );
  }

  const lineFrames = reference.facts.frameCount - referenceOnset;
  const deliveredRemaining = delivered.facts.frameCount - deliveredOnset;
  const toleranceFrames = Math.round(TRUNCATION_TOLERANCE_S * reference.facts.sampleRate);
  if (lineFrames <= 0) {
    throw new TimbreComparisonError(
      "truncated",
      `the reference ${referencePath} has no samples after its onset`,
    );
  }
  if (deliveredRemaining < lineFrames - toleranceFrames) {
    const deliveredSeconds = deliveredRemaining / delivered.facts.sampleRate;
    const shortSeconds = (lineFrames - deliveredRemaining) / reference.facts.sampleRate;
    if (
      ending !== undefined &&
      ending.captureComplete &&
      ending.endedBy !== null &&
      ending.producedSeconds !== null &&
      ending.producedSeconds - deliveredSeconds > TRUNCATION_TOLERANCE_S
    ) {
      throw new TimbreComparisonError(
        "call-ended",
        `the call ended (${ending.endedBy}) with the line still queued: ${deliveredSeconds.toFixed(3)} s ` +
          `of the ${ending.producedSeconds.toFixed(3)} s the service produced reached the delivered ` +
          `capture, which reported complete; ${shortSeconds.toFixed(3)} s short of the reference line ` +
          "means the line was cut by the call's end, not lost by the tap",
      );
    }
    throw new TimbreComparisonError(
      "truncated",
      `the delivered capture ${deliveredPath} is ` +
        `${shortSeconds.toFixed(3)} s short of ` +
        `the reference line; a truncated line is not a timbre measurement`,
    );
  }

  const frames = Math.min(lineFrames, deliveredRemaining);
  const referenceLine = sliceAudio(reference, referenceOnset, frames);
  const deliveredLine = sliceAudio(delivered, deliveredOnset, frames);
  // A positive lag means the delivered copy starts later than the frame its
  // onset named; move that start forward, and the other file's only when the
  // lag is negative, so the two slices hold the same samples.
  const lag = fineLag(referenceLine, deliveredLine);
  const referenceSkip = lag < 0 ? -lag : 0;
  const deliveredSkip = lag > 0 ? lag : 0;
  const alignedFrames = Math.max(0, frames - Math.abs(lag));
  return {
    reference: {
      path: referencePath,
      audio: sliceAudio(reference, referenceOnset + referenceSkip, alignedFrames),
    },
    delivered: {
      path: deliveredPath,
      audio: sliceAudio(delivered, deliveredOnset + deliveredSkip, alignedFrames),
    },
    onsetDeltaMs: Math.round(((deliveredOnset - referenceOnset) / reference.facts.sampleRate) * 1000),
  };
}

/** The measured axes A3 and A5 read, in one object. */
export type ComparedAxes = {
  /** Delivered minus reference integrated loudness, in LU (signed). */
  readonly levelDeltaLu: number;
  /** Delivered depth minus reference depth, clamped at zero. */
  readonly modulationDelta: number;
  readonly truePeakDbtp: number;
  /** Residual against the reference, in dB. */
  readonly distortionDb: number;
  readonly crest: number;
  /** Worst octave-band move after each capture is level-normalised, in dB. */
  readonly bandDeltaDb: number;
  readonly breakups: number;
  /** The frozen pairing window, in seconds; a parameter, not a new bar. */
  readonly breakupMatchSeconds: number;
  readonly timbre: MeasuredTimbreResult;
  readonly alignment: AlignedPair;
};

function axisValue(timbre: MeasuredTimbreResult, axis: string): number | null {
  return timbre.axes.find((entry) => entry.axis === axis)?.value ?? null;
}

/** Measure every axis A3 and A5 need on one aligned pair. */
export function compareTimbre(
  reference: DecodedAudio,
  referencePath: string,
  delivered: DecodedAudio,
  deliveredPath: string,
  ending?: LineEnding,
): ComparedAxes {
  const alignment = alignToReference(reference, delivered, referencePath, deliveredPath, ending);
  const timbre = measureTimbre({
    reference: { path: referencePath, audio: alignment.reference.audio },
    delivered: { path: deliveredPath, audio: alignment.delivered.audio },
  });
  if (timbre.refusals.length > 0) {
    throw new TimbreComparisonError(
      "unmeasured",
      `timbre refused before measurement: ${timbre.refusals.join("; ")}`,
    );
  }

  const referenceLevel = analyseLevel(alignment.reference.audio);
  const deliveredLevel = analyseLevel(alignment.delivered.audio);
  if (!referenceLevel.measured || !deliveredLevel.measured) {
    throw new TimbreComparisonError(
      "unmeasured",
      `level is unmeasured: reference ${referenceLevel.measured ? "measured" : referenceLevel.absence}, ` +
        `delivered ${deliveredLevel.measured ? "measured" : deliveredLevel.absence}`,
    );
  }

  let modulationDelta: number;
  try {
    const referenceModulation = measureEnvelopeModulation(alignment.reference.audio);
    const deliveredModulation = measureEnvelopeModulation(alignment.delivered.audio);
    modulationDelta = Math.max(0, deliveredModulation.depth - referenceModulation.depth);
  } catch (error) {
    throw new TimbreComparisonError(
      "unmeasured",
      `the envelope could not be measured: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const axes = {
    truePeak: axisValue(timbre, "truePeak"),
    distortion: axisValue(timbre, "distortion"),
    crest: axisValue(timbre, "crest"),
    bandDelta: axisValue(timbre, "spectralBalance"),
    breakups: axisValue(timbre, "breakups"),
  };
  const missing = Object.entries(axes)
    .filter(([, value]) => value === null)
    .map(([axis]) => axis);
  if (missing.length > 0) {
    throw new TimbreComparisonError(
      "unmeasured",
      `timbre axes unmeasured: ${missing.join(", ")}; ${timbre.detail}`,
    );
  }

  return {
    levelDeltaLu: deliveredLevel.integratedLufs - referenceLevel.integratedLufs,
    modulationDelta,
    truePeakDbtp: axes.truePeak!,
    distortionDb: axes.distortion!,
    crest: axes.crest!,
    bandDeltaDb: axes.bandDelta!,
    breakups: axes.breakups!,
    breakupMatchSeconds: BREAKUP_MATCH_SECONDS,
    timbre,
    alignment,
  };
}
