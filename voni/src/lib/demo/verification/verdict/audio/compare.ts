/**
 * The delivered capture against the committed voice reference.
 *
 * A3, A5 and A8 need the same two things: the delivered greeting aligned to the
 * reference line, and the six measured timbre axes on that pair. Alignment
 * starts each file at its own audible onset, so a lead-in is a reported fact
 * rather than a timbre difference; a delivered line too short to hold the
 * reference is a refusal, never a quietly shortened measurement.
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

export type TimbreComparisonErrorCode =
  | "format-mismatch"
  | "no-onset"
  | "truncated"
  | "unmeasured";

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
 * Align the delivered line to the reference by each file's own onset. A
 * different rate or channel count is a refusal; so is a delivered line more
 * than 50 ms short of the reference.
 */
export function alignToReference(
  reference: DecodedAudio,
  delivered: DecodedAudio,
  referencePath: string,
  deliveredPath: string,
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
    throw new TimbreComparisonError(
      "truncated",
      `the delivered capture ${deliveredPath} is ` +
        `${((lineFrames - deliveredRemaining) / reference.facts.sampleRate).toFixed(3)} s short of ` +
        `the reference line; a truncated line is not a timbre measurement`,
    );
  }

  const frames = Math.min(lineFrames, deliveredRemaining);
  return {
    reference: { path: referencePath, audio: sliceAudio(reference, referenceOnset, frames) },
    delivered: { path: deliveredPath, audio: sliceAudio(delivered, deliveredOnset, frames) },
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
): ComparedAxes {
  const alignment = alignToReference(reference, delivered, referencePath, deliveredPath);
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
