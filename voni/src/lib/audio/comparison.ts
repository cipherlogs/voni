/**
 * The W0 comparison: one table over three saved captures of the same line —
 * the reference rendering, the platform's recording of the agent channel, and
 * the audio the browser actually played.
 *
 * The table is measurements only. Every value is produced by the metric
 * modules beside this one over the same decoded samples, and a metric a file
 * cannot carry is named as unmeasured instead of being dropped or guessed.
 * Files at different rates or channel counts still produce a table: a
 * cross-file metric that needs one format names the mismatch in its cell.
 *
 * The `rows` are the stable seam for the verdict (ticket 15): each row has a
 * fixed id, a group and three cells, so the first divergence can be named
 * without re-measuring anything. The raw readings stay on `captures` for a
 * verdict that needs a position (a breakup's start) rather than only a count.
 * The onset row is the alignment fact: a capture that starts late carries a
 * lead-in, which is not a defect by itself but stops a verdict from blaming a
 * layer while the files are not comparable sample-for-sample. This module
 * never decides which layer is at fault.
 */
import { detectBreakups, type BreakupReport } from "./breakups";
import {
  DistortionCrestError,
  crestFactor,
  distortionResidual,
  type CrestFactor,
  type DistortionResidual,
} from "./distortion-crest";
import { measureEnvelopeModulation, type EnvelopeModulation } from "./envelope-modulation";
import type { DecodedAudio } from "./format-facts";
import { analyseLevel, LevelFactsError, type LevelFacts } from "./level-facts";
import { NATIVE_GAIN_STAGE, assertNoLevelStage } from "./native-level";
import {
  SPEECH_OCTAVE_CENTRES,
  measureSpectralBalance,
  type SpectralBalance,
} from "./spectral-balance";
import { SCOREBOARD_BUDGETS, type BudgetKey, type BudgetUnit } from "../demo/scoreboard-budgets";

/** The three captures, in table order: reference, platform, delivered. */
export const CAPTURE_ROLES = ["reference", "platform", "delivered"] as const;

export type CaptureRole = (typeof CAPTURE_ROLES)[number];

/** One decoded capture. Decoding happens before the table is built. */
export type CaptureInput = {
  role: CaptureRole;
  /** Where the file was read from, printed beside its column. */
  path: string;
  audio: DecodedAudio;
};

export type ComparisonGroup = "format" | "level" | "shape" | "spectrum" | "modulation" | "breakups";

export const COMPARISON_GROUPS: readonly ComparisonGroup[] = [
  "format",
  "level",
  "shape",
  "spectrum",
  "modulation",
  "breakups",
];

/** Every row the table prints, in order. A verdict may key off these ids. */
export type ComparisonRowId =
  | "sample-rate"
  | "channels"
  | "duration"
  | "byte-rate"
  | "onset"
  | "integrated"
  | "rms"
  | "true-peak"
  | "distortion"
  | "crest"
  | `octave-${number}`
  | "band-spread"
  | "band-delta"
  | "modulation-rate"
  | "modulation-depth"
  | "breakup-count"
  | "breakup-total"
  | "breakup-longest";

export type ComparisonCell =
  | { kind: "value"; value: number }
  | { kind: "text"; text: string }
  | { kind: "unmeasured"; reason: string };

export type ComparisonRow<Role extends string = CaptureRole> = {
  id: ComparisonRowId;
  group: ComparisonGroup;
  /** Printed at the left of the row. A per-band row carries its centre. */
  label: string;
  /** Decimal places for a numeric value; ignored by text and unmeasured. */
  decimals: number;
  /** A delta keeps its direction in the sign, so a tilt never reads unsigned. */
  signed?: boolean;
  /**
   * The module and entry point that produced the reading. A metric with no
   * named producer is not evidence: a reader can open the implementation
   * rather than trusting a number that appeared in a table.
   */
  producer: MetricProducer;
  cells: Record<Role, ComparisonCell>;
};

/**
 * The one producer name per metric family. These are the modules beside this
 * one; the table never reimplements a measurement.
 */
export const METRIC_PRODUCERS = {
  formatFacts: "format-facts.decodeWav",
  onset: "comparison.measureOnset",
  level: "level-facts.analyseLevel",
  distortion: "distortion-crest.distortionResidual",
  crest: "distortion-crest.crestFactor",
  spectrum: "spectral-balance.measureSpectralBalance",
  modulation: "envelope-modulation.measureEnvelopeModulation",
  breakups: "breakups.detectBreakups",
} as const;

export type MetricProducer = (typeof METRIC_PRODUCERS)[keyof typeof METRIC_PRODUCERS];

/** A metric the file cannot carry, named rather than guessed. */
export type Reading<T> = { measured: true; value: T } | { measured: false; reason: string };

/** Distortion is relative, so the reference is a baseline, not a reading. */
export type DistortionReading =
  | { kind: "baseline" }
  | { kind: "measured"; residual: DistortionResidual }
  | { kind: "unmeasured"; reason: string };

export type CaptureFacts<Role extends string = CaptureRole> = {
  role: Role;
  path: string;
  format: DecodedAudio["facts"];
  /** Where the first audible frame starts; the verdict needs it to see misalignment. */
  onset: Reading<{ seconds: number }>;
  level: Reading<Extract<LevelFacts, { measured: true }>>;
  distortion: DistortionReading;
  crest: Reading<CrestFactor>;
  spectrum: Reading<SpectralBalance>;
  modulation: Reading<EnvelopeModulation>;
  breakups: Reading<BreakupReport>;
};

export type AudioComparison = {
  /** The three captures in `CAPTURE_ROLES` order. */
  captures: CaptureFacts[];
  /** Octave bands every capture can measure, ascending. */
  octaveBandsHz: readonly number[];
  /** The band pair the band-to-band delta is quoted between. */
  tilt: { fromCentreHz: number; toCentreHz: number } | null;
  /** Every metric row, grouped in `COMPARISON_GROUPS` order. */
  rows: ComparisonRow[];
};

/** A refused comparison: the three captures are the contract. */
export class ComparisonError extends Error {
  constructor(
    readonly code: "missing-capture" | "duplicate-capture",
    message: string,
  ) {
    super(message);
    this.name = "ComparisonError";
  }
}

function emptyCells<Role extends string>(roles: readonly Role[]): Record<Role, ComparisonCell> {
  return Object.fromEntries(
    roles.map((role) => [role, { kind: "unmeasured" as const, reason: "not measured" }]),
  ) as Record<Role, ComparisonCell>;
}

/** A role whose capture could not be read; every one of its cells says why. */
export type MissingCapture<Role extends string = CaptureRole> = {
  role: Role;
  missingReason: string;
};

export type RowCapture<Role extends string = CaptureRole> =
  | CaptureFacts<Role>
  | MissingCapture<Role>;

function isMissing<Role extends string>(
  capture: RowCapture<Role>,
): capture is MissingCapture<Role> {
  return "missingReason" in capture;
}

/**
 * Order the captures and refuse anything but exactly one of each role. A
 * duplicated or absent role would silently merge two layers into one column.
 */
function orderCaptures(inputs: readonly CaptureInput[]): CaptureInput[] {
  const ordered: CaptureInput[] = [];
  for (const role of CAPTURE_ROLES) {
    const matches = inputs.filter((input) => input.role === role);
    if (matches.length === 0) {
      throw new ComparisonError("missing-capture", `comparison needs a ${role} capture`);
    }
    if (matches.length > 1) {
      throw new ComparisonError(
        "duplicate-capture",
        `comparison received ${matches.length} ${role} captures; one per role is the contract`,
      );
    }
    ordered.push(matches[0]);
  }
  return ordered;
}

function formatRows<Role extends string>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
): ComparisonRow<Role>[] {
  const row = (
    id: ComparisonRowId,
    label: string,
    decimals: number,
    pick: (capture: CaptureFacts<Role>) => number,
  ): ComparisonRow<Role> => {
    const cells = emptyCells(roles);
    for (const capture of captures) {
      cells[capture.role] = isMissing(capture)
        ? { kind: "unmeasured", reason: capture.missingReason }
        : { kind: "value", value: pick(capture) };
    }
    return { id, group: "format", label, decimals, producer: METRIC_PRODUCERS.formatFacts, cells };
  };

  return [
    row("sample-rate", "sample rate (Hz)", 0, (capture) => capture.format.sampleRate),
    row("channels", "channels", 0, (capture) => capture.format.channels),
    row("duration", "duration (s)", 2, (capture) => capture.format.durationSeconds),
    row("byte-rate", "byte rate (B/s)", 0, (capture) => capture.format.byteRate),
  ];
}
type MeasuredLevel = Extract<LevelFacts, { measured: true }>;

/** First frame length the onset reads; also the resolution of the number. */
const ONSET_FRAME_SECONDS = 0.01;
/** A frame quieter than this is lead-in, not speech. */
const ONSET_FLOOR_DBFS = -40;
const ONSET_FLOOR_AMPLITUDE = 10 ** (ONSET_FLOOR_DBFS / 20);

/**
 * Where audible signal starts, so the verdict can see that two captures do not
 * share a start. A lead-in is a fact about the capture, never a defect by
 * itself: the comparison reports it and the verdict refuses to blame a layer
 * from unaligned files.
 */
function measureOnset(audio: DecodedAudio): Reading<{ seconds: number }> {
  const { sampleRate, channels, frameCount } = audio.facts;
  const frameSamples = Math.max(1, Math.round(ONSET_FRAME_SECONDS * sampleRate));
  const fullScale = 32_768;

  for (let start = 0; start < frameCount; start += frameSamples) {
    const end = Math.min(start + frameSamples, frameCount);
    let sumSquares = 0;
    for (let frame = start; frame < end; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = audio.samples[frame * channels + channel] / fullScale;
        sumSquares += sample * sample;
      }
    }
    const rms = Math.sqrt(sumSquares / ((end - start) * channels));
    if (rms > ONSET_FLOOR_AMPLITUDE) {
      return { measured: true, value: { seconds: start / sampleRate } };
    }
  }
  return { measured: false, reason: `no audible onset above ${ONSET_FLOOR_DBFS} dBFS` };
}

/** A level the module refuses is named; an unexpected failure still throws. */
function measureLevel(audio: DecodedAudio): Reading<MeasuredLevel> {
  try {
    const facts = analyseLevel(audio);
    return facts.measured
      ? { measured: true, value: facts }
      : { measured: false, reason: facts.absence };
  } catch (error) {
    if (error instanceof LevelFactsError) return { measured: false, reason: error.message };
    throw error;
  }
}

/**
 * One metric row over a per-file reading: a measured value, or the reason the
 * file cannot carry it. Every metric row is built here, so the three columns
 * cannot disagree about what "unmeasured" looks like.
 */
function readingRow<Role extends string, T>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
  group: ComparisonGroup,
  id: ComparisonRowId,
  label: string,
  decimals: number,
  producer: MetricProducer,
  reading: (capture: CaptureFacts<Role>) => Reading<T>,
  pick: (value: T) => number,
): ComparisonRow<Role> {
  const cells = emptyCells(roles);
  for (const capture of captures) {
    if (isMissing(capture)) {
      cells[capture.role] = { kind: "unmeasured", reason: capture.missingReason };
      continue;
    }
    const value = reading(capture);
    cells[capture.role] = value.measured
      ? { kind: "value", value: pick(value.value) }
      : { kind: "unmeasured", reason: value.reason };
  }
  return { id, group, label, decimals, producer, cells };
}

function onsetRows<Role extends string>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
): ComparisonRow<Role>[] {
  return [
    readingRow(
      roles,
      captures,
      "format",
      "onset",
      "onset (s)",
      3,
      METRIC_PRODUCERS.onset,
      (capture) => capture.onset,
      (onset) => onset.seconds,
    ),
  ];
}

function levelRows<Role extends string>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
): ComparisonRow<Role>[] {
  const level = (capture: CaptureFacts<Role>) => capture.level;
  return [
    readingRow(roles, captures, "level", "integrated", "integrated (LUFS)", 2, METRIC_PRODUCERS.level, level, (facts) => facts.integratedLufs),
    readingRow(roles, captures, "level", "rms", "RMS (dBFS)", 2, METRIC_PRODUCERS.level, level, (facts) => facts.rmsDbfs),
    readingRow(roles, captures, "level", "true-peak", "true peak (dBTP)", 2, METRIC_PRODUCERS.level, level, (facts) => facts.truePeakDbtp),
  ];
}

function formatPair(facts: DecodedAudio["facts"]): string {
  return `${facts.sampleRate} Hz x${facts.channels}ch`;
}

/**
 * Distortion is quoted against the reference, so the reference is a baseline.
 * A file whose format the residual cannot compare is named, not resampled:
 * resampling would move the rate defect into the measurement.
 */
function measureDistortion(
  reference: { audio: DecodedAudio },
  capture: { role: string; audio: DecodedAudio },
): DistortionReading {
  if (capture.role === "reference") return { kind: "baseline" };
  try {
    return { kind: "measured", residual: distortionResidual(reference.audio, capture.audio) };
  } catch (error) {
    if (error instanceof DistortionCrestError) {
      return {
        kind: "unmeasured",
        reason: `format mismatch (${formatPair(reference.audio.facts)} vs ${formatPair(capture.audio.facts)})`,
      };
    }
    throw error;
  }
}

function measureCrest(audio: DecodedAudio): Reading<CrestFactor> {
  const crest = crestFactor(audio);
  return Number.isFinite(crest.crestFactor)
    ? { measured: true, value: crest }
    : { measured: false, reason: "silent signal" };
}

function shapeRows<Role extends string>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
): ComparisonRow<Role>[] {
  const distortion = emptyCells(roles);
  const crest = emptyCells(roles);
  for (const capture of captures) {
    if (isMissing(capture)) {
      distortion[capture.role] = { kind: "unmeasured", reason: capture.missingReason };
      crest[capture.role] = { kind: "unmeasured", reason: capture.missingReason };
      continue;
    }
    const reading = capture.distortion;
    if (reading.kind === "baseline") {
      distortion[capture.role] = { kind: "text", text: "reference" };
    } else if (reading.kind === "unmeasured") {
      distortion[capture.role] = { kind: "unmeasured", reason: reading.reason };
    } else {
      const residualDb = reading.residual.residualDb;
      distortion[capture.role] = !Number.isFinite(residualDb)
        ? {
            kind: "text",
            text: residualDb === -Infinity ? "no residual" : "no delivered signal",
          }
        : { kind: "value", value: residualDb };
    }

    crest[capture.role] = capture.crest.measured
      ? { kind: "value", value: capture.crest.value.crestFactor }
      : { kind: "unmeasured", reason: capture.crest.reason };
  }

  return [
    {
      id: "distortion",
      group: "shape",
      label: "distortion vs reference (dB)",
      decimals: 1,
      producer: METRIC_PRODUCERS.distortion,
      cells: distortion,
    },
    {
      id: "crest",
      group: "shape",
      label: "crest factor (peak/RMS)",
      decimals: 3,
      producer: METRIC_PRODUCERS.crest,
      cells: crest,
    },
  ];
}

/** Octave centres a sample rate can actually carry, ascending. */
function availableBands(sampleRate: number): number[] {
  const nyquist = sampleRate / 2;
  return SPEECH_OCTAVE_CENTRES.filter((centreHz) => centreHz * Math.SQRT2 <= nyquist);
}

/**
 * The band pair every capture can measure, so the delta is one comparison
 * rather than a different pair per column. Full rate quotes 500→4000 Hz; a
 * narrow capture quotes the widest pair it carries.
 */
function tiltPairFor(bands: readonly number[]): { fromCentreHz: number; toCentreHz: number } | null {
  if (bands.length < 2) return null;
  const toCentreHz = bands.includes(4_000) ? 4_000 : bands[bands.length - 1];
  const fromCentreHz = bands.includes(500) ? 500 : bands[0];
  if (fromCentreHz !== toCentreHz) return { fromCentreHz, toCentreHz };
  return { fromCentreHz: bands[0], toCentreHz: bands[bands.length - 1] };
}

type SpectralContext = {
  bands: readonly number[];
  tilt: { fromCentreHz: number; toCentreHz: number } | null;
};

/**
 * Measure a file's octave bands only where every capture has them, and quote
 * the same tilt pair everywhere. A format the module refuses is named.
 */
function measureSpectrum(
  audio: DecodedAudio,
  context: SpectralContext,
): Reading<SpectralBalance> {
  if (context.tilt === null) {
    return { measured: false, reason: "needs two octave bands to quote a balance" };
  }
  try {
    return {
      measured: true,
      value: measureSpectralBalance(audio, {
        centresHz: context.bands,
        tilt: context.tilt,
      }),
    };
  } catch (error) {
    if (error instanceof RangeError) return { measured: false, reason: error.message };
    throw error;
  }
}

function measureModulation(audio: DecodedAudio): Reading<EnvelopeModulation> {
  try {
    return { measured: true, value: measureEnvelopeModulation(audio) };
  } catch (error) {
    if (error instanceof RangeError) return { measured: false, reason: error.message };
    throw error;
  }
}

function measureBreakups(audio: DecodedAudio): Reading<BreakupReport> {
  try {
    return { measured: true, value: detectBreakups(audio) };
  } catch (error) {
    if (error instanceof RangeError) return { measured: false, reason: error.message };
    throw error;
  }
}

function breakupRows<Role extends string>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
): ComparisonRow<Role>[] {
  const breakups = (capture: CaptureFacts<Role>) => capture.breakups;
  return [
    readingRow(roles, captures, "breakups", "breakup-count", "breakup count", 0, METRIC_PRODUCERS.breakups, breakups, (report) => report.count),
    readingRow(roles, captures, "breakups", "breakup-total", "breakup total silence (s)", 3, METRIC_PRODUCERS.breakups, breakups, (report) => report.totalSeconds),
    readingRow(roles, captures, "breakups", "breakup-longest", "breakup longest silence (s)", 3, METRIC_PRODUCERS.breakups, breakups, (report) => report.longestSeconds),
  ];
}

function spectrumRows<Role extends string>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
  context: SpectralContext,
): ComparisonRow<Role>[] {
  const cellFor = (
    capture: RowCapture<Role>,
    pick: (spectrum: SpectralBalance) => number,
  ): ComparisonCell => {
    if (isMissing(capture)) return { kind: "unmeasured", reason: capture.missingReason };
    if (!capture.spectrum.measured) {
      return { kind: "unmeasured", reason: capture.spectrum.reason };
    }
    return { kind: "value", value: pick(capture.spectrum.value) };
  };

  const bandRows: ComparisonRow<Role>[] = context.bands.map((centreHz) => {
    const cells = emptyCells(roles);
    for (const capture of captures) {
      if (isMissing(capture)) {
        cells[capture.role] = { kind: "unmeasured", reason: capture.missingReason };
        continue;
      }
      const band = capture.spectrum.measured
        ? capture.spectrum.value.bands.find((entry) => entry.centreHz === centreHz)
        : undefined;
      cells[capture.role] = band
        ? { kind: "value", value: band.levelDb }
        : {
            kind: "unmeasured",
            reason: capture.spectrum.measured
              ? `${centreHz} Hz band not measured`
              : capture.spectrum.reason,
          };
    }
    return {
      id: `octave-${centreHz}` as const,
      group: "spectrum",
      label: `${centreHz} Hz band (dBFS)`,
      decimals: 1,
      producer: METRIC_PRODUCERS.spectrum,
      cells,
    };
  });

  const spread = emptyCells(roles);
  const delta = emptyCells(roles);
  for (const capture of captures) {
    spread[capture.role] = cellFor(capture, (spectrum) => spectrum.spreadDb);
    delta[capture.role] = cellFor(capture, (spectrum) => spectrum.tilt.deltaDb);
  }

  const tiltLabel =
    context.tilt === null
      ? "band delta (dB)"
      : `band delta ${context.tilt.fromCentreHz}→${context.tilt.toCentreHz} Hz (dB)`;

  return [
    ...bandRows,
    {
      id: "band-spread",
      group: "spectrum",
      label: "band spread (dB)",
      decimals: 1,
      producer: METRIC_PRODUCERS.spectrum,
      cells: spread,
    },
    {
      id: "band-delta",
      group: "spectrum",
      label: tiltLabel,
      decimals: 1,
      signed: true,
      producer: METRIC_PRODUCERS.spectrum,
      cells: delta,
    },
  ];
}

function modulationRows<Role extends string>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
): ComparisonRow<Role>[] {
  const modulation = (capture: CaptureFacts<Role>) => capture.modulation;
  return [
    readingRow(roles, captures, "modulation", "modulation-rate", "modulation rate (Hz)", 1, METRIC_PRODUCERS.modulation, modulation, (reading) => reading.rateHz),
    readingRow(roles, captures, "modulation", "modulation-depth", "modulation depth (%)", 1, METRIC_PRODUCERS.modulation, modulation, (reading) => reading.depth * 100),
  ];
}

/** The octave bands every capture can measure, and the one tilt pair. */
function spectralContextFor(inputs: readonly { audio: DecodedAudio }[]): SpectralContext {
  if (inputs.length === 0) return { bands: [], tilt: null };
  const commonBands = inputs
    .map((input) => availableBands(input.audio.facts.sampleRate))
    .reduce((shared, bands) => shared.filter((centre) => bands.includes(centre)));
  return { bands: commonBands, tilt: tiltPairFor(commonBands) };
}

/** Measure one capture against the reference and attach its per-file readings. */
function measureFacts<Role extends string>(
  ordered: readonly { role: Role; path: string; audio: DecodedAudio }[],
  spectral: SpectralContext,
): CaptureFacts<Role>[] {
  return ordered.map((input) => ({
    role: input.role,
    path: input.path,
    format: input.audio.facts,
    onset: measureOnset(input.audio),
    level: measureLevel(input.audio),
    distortion: measureDistortion(ordered[0], input),
    crest: measureCrest(input.audio),
    spectrum: measureSpectrum(input.audio, spectral),
    modulation: measureModulation(input.audio),
    breakups: measureBreakups(input.audio),
  }));
}

/** Every row, in the one order the verdict keys off. */
function buildRows<Role extends string>(
  roles: readonly Role[],
  captures: readonly RowCapture<Role>[],
  spectral: SpectralContext,
): ComparisonRow<Role>[] {
  return [
    ...formatRows(roles, captures),
    ...onsetRows(roles, captures),
    ...levelRows(roles, captures),
    ...shapeRows(roles, captures),
    ...spectrumRows(roles, captures, spectral),
    ...modulationRows(roles, captures),
    ...breakupRows(roles, captures),
  ];
}

/** Measure the three captures and build every table row. Pure over its input. */
export function compareCaptures(inputs: readonly CaptureInput[]): AudioComparison {
  const ordered = orderCaptures(inputs);
  const spectral = spectralContextFor(ordered);
  const captures = measureFacts(ordered, spectral);
  const rows = buildRows(CAPTURE_ROLES, captures, spectral);
  return {
    captures,
    octaveBandsHz: spectral.bands,
    tilt: spectral.tilt,
    rows,
  };
}

// ── W0: one table over the reference and the delivered capture ───────────────

/**
 * A cascade call has no platform recording (spec W0), so the comparison is one
 * table over exactly two captures. The role list is the contract: a third
 * column would be a platform leg the cascade does not have.
 */
export const TWO_CAPTURE_ROLES = ["reference", "delivered"] as const;
export type TwoCaptureRole = (typeof TWO_CAPTURE_ROLES)[number];

/**
 * What the capture's producer says it holds. A description that disagrees with
 * the decoded header, or with the line being compared, is a misdescribed
 * capture: the file is not what the evidence claims, so it cannot be judged.
 */
export type TwoCaptureDescription = {
  /** The sample rate the producer says the file was written at, in Hz. */
  sampleRate?: number;
  /** The channel count the producer says the file carries. */
  channels?: number;
  /** The line the producer says the file speaks. */
  text?: string;
};

/** A decoded capture. Decoding happens before the table is built. */
export type TwoCaptureDecoded = {
  path: string;
  audio: DecodedAudio;
  /** Optional provenance the file must agree with, or it is misdescribed. */
  description?: TwoCaptureDescription;
};

/** A capture that could not be compared, named by what went wrong. */
export type TwoCaptureFailure = {
  path: string;
  reason: string;
  /** Defaults to `unreadable`; a caller may name a missing, empty or truncated file. */
  kind?: "missing" | "zero-byte" | "truncated" | "unreadable";
};

export type TwoCaptureSlot = TwoCaptureDecoded | TwoCaptureFailure;

/** Why a capture cannot enter the comparison. Every code blocks a pass. */
export type TwoCaptureProblemCode =
  | "missing"
  | "zero-byte"
  | "unreadable"
  | "truncated"
  | "header-only"
  | "stereo"
  | "wrong-rate"
  | "misdescribed"
  | "wrong-line";

/** A refused capture: the code a caller can branch on and the printed reason. */
export type TwoCaptureProblem = {
  code: TwoCaptureProblemCode;
  reason: string;
};

/**
 * The marker that says what part of the capture is the line. A whole call
 * without one is incomplete: comparing a full conversation to a one-sentence
 * reference would blame the sentence for every later turn.
 */
export type TwoCaptureLine =
  | {
      kind: "greeting";
      /** The exact line the reference renders, so a different line is visible. */
      text: string;
    }
  | {
      kind: "segment";
      text: string;
      /** Start and end of the marked line in the delivered capture, in seconds. */
      startSeconds: number;
      endSeconds: number;
    };

export type TwoCaptureRequest = {
  reference: TwoCaptureSlot | null;
  delivered: TwoCaptureSlot | null;
  line: TwoCaptureLine | null;
  /** The transcript's rendering of the same line; a mismatch is unresolved. */
  spokenLine?: string;
  /**
   * The format the call negotiated. A capture in another format is a
   * wrong-rate capture, never a silent resampling.
   */
  expectedFormat?: { sampleRate: number; channels: number };
};

export type TwoCaptureCapture = {
  role: TwoCaptureRole;
  path: string;
  /** True only when the capture is present, decodable and usable by this profile. */
  present: boolean;
  /** Why the capture cannot be compared; null when it is usable. */
  reason: string | null;
  /** The named problem, for a caller that branches on the code. */
  problem: TwoCaptureProblem | null;
};

export type TwoCaptureComparison = {
  profile: "w0-two-capture";
  status: "measured" | "unresolved";
  /** Every reason the table cannot compare sample-for-sample; empty only when measured. */
  unresolvedReasons: string[];
  /** The cascade has no gain stage: the table reads the captures at native level. */
  gainStage: "none";
  line: TwoCaptureLine | null;
  alignment: {
    /** Reference onset minus delivered onset, in seconds; null when unmeasured. */
    onsetDeltaSeconds: number | null;
    /**
     * The bar from the frozen budget record (`comparisonOnsetToleranceS`), never
     * a number restated here.
     */
    toleranceSeconds: number;
    withinTolerance: boolean | null;
    /** True only when both captures are present, same format and aligned. */
    sampleAligned: boolean;
  };
  captures: TwoCaptureCapture[];
  /** Octave bands every capture can measure, ascending. */
  octaveBandsHz: readonly number[];
  tilt: { fromCentreHz: number; toCentreHz: number } | null;
  rows: ComparisonRow<TwoCaptureRole>[];
  /**
   * The playout signatures, each measured on the aligned pair. These are what
   * separates our pipeline from the client: a hole, a chunk-rate envelope
   * swing, a folded band or a partial gain dip is playback, not a server-side
   * timbre change.
   */
  clientSignatures: ClientSignature[];
  /**
   * The pairwise pipeline axes on the aligned pair, with client-owned damage
   * masked out and a slow gain envelope divided out, so a client hole or a
   * client fade cannot be re-read as a server-side level or residual defect.
   */
  pipeline: W0PipelineAudit;
};

/** A time window one capture owns, in seconds from the start of the aligned file. */
export type SignatureInterval = { startSeconds: number; seconds: number };

/** The four client-owned signatures a delivered capture can carry. */
export const CLIENT_SIGNATURE_KINDS = [
  "inserted-silence",
  "chunk-rate-modulation",
  "device-rate-alias",
  "boundary-fade",
] as const;

export type ClientSignatureKind = (typeof CLIENT_SIGNATURE_KINDS)[number];

export type SignatureThreshold = {
  key: BudgetKey;
  value: number;
  unit: BudgetUnit;
};

export type ClientSignature = {
  kind: ClientSignatureKind;
  detected: boolean;
  /** The measured value the decision rests on: holes, depth ratio, bands, dip dB. */
  value: number;
  /** The frozen bar, when this signature enforces one. */
  bar: SignatureThreshold | null;
  /** Windows the signature owns, so the pipeline audit can mask them. */
  intervals: SignatureInterval[];
  /** One sentence naming the measurement and the bar. */
  detail: string;
  /** Why the signature could not be measured; null when it was. */
  reason: string | null;
};

/** The pipeline axes measured after the client's damage is taken out. */
export type W0PipelineAudit = {
  /** Why the audit is unmeasured; null when it was measured. */
  reason: string | null;
  /** Every client-owned window zeroed in both captures before comparing. */
  masked: SignatureInterval[];
  /**
   * Axes a detected client signature imitates, so the two captures cannot
   * separate the server's audio from playback. These are SKIPPED, never read
   * as a pipeline failure.
   */
  clientOwned: ("spectrum" | "distortion")[];
  level: Reading<{ referenceLufs: number; deliveredLufs: number; deltaLu: number }>;
  peak: Reading<{ referenceDbtp: number; deliveredDbtp: number }>;
  distortion: Reading<{ residualDb: number }>;
  spectrum: Reading<{ referenceDeltaDb: number; deliveredDeltaDb: number; deltaDb: number }>;
  crest: Reading<{ reference: number; delivered: number }>;
};

function isDecoded(slot: TwoCaptureSlot | null): slot is TwoCaptureDecoded {
  return slot !== null && "audio" in slot;
}

/**
 * The W0 profile requires one mono, 16-bit PCM WAV per leg. A capture that is
 * missing, unreadable, zero-byte, header-only, stereo, at another rate than the
 * call negotiated, or described as something it is not, is named here and
 * never measured as if it were a normal file.
 */
function captureProblem(
  role: TwoCaptureRole,
  slot: TwoCaptureSlot | null,
  line: TwoCaptureLine | null,
  expectedFormat: TwoCaptureRequest["expectedFormat"],
): TwoCaptureProblem | null {
  if (slot === null) {
    return { code: "missing", reason: `${role} capture missing: no file supplied` };
  }
  if (!isDecoded(slot)) {
    const kind = slot.kind ?? "unreadable";
    return { code: kind, reason: `${role} capture ${kind}: ${slot.path}: ${slot.reason}` };
  }

  const facts = slot.audio.facts;
  if (facts.frameCount === 0 || slot.audio.samples.length === 0) {
    return {
      code: "header-only",
      reason:
        `${role} capture header-only: ${slot.path}: the file has a header and ` +
        "0 sample frames, so there is nothing to measure",
    };
  }
  if (facts.channels !== 1) {
    return {
      code: "stereo",
      reason:
        `${role} capture format mismatch: ${facts.channels} channels; the W0 profile compares ` +
        "mono captures, so a multi-channel file is not the capture the profile names",
    };
  }
  if (expectedFormat !== undefined && facts.sampleRate !== expectedFormat.sampleRate) {
    return {
      code: "wrong-rate",
      reason:
        `${role} capture is ${facts.sampleRate} Hz but the call negotiated ` +
        `${expectedFormat.sampleRate} Hz; a wrong-rate capture is unresolved rather than resampled`,
    };
  }

  const description = slot.description;
  if (description !== undefined) {
    if (description.sampleRate !== undefined && description.sampleRate !== facts.sampleRate) {
      return {
        code: "misdescribed",
        reason:
          `${role} capture misdescribed: ${slot.path}: the description says ` +
          `${description.sampleRate} Hz, the file is ${facts.sampleRate} Hz`,
      };
    }
    if (description.channels !== undefined && description.channels !== facts.channels) {
      return {
        code: "misdescribed",
        reason:
          `${role} capture misdescribed: ${slot.path}: the description says ` +
          `${description.channels} channels, the file has ${facts.channels}`,
      };
    }
    if (description.text !== undefined && line !== null && !sameLine(line.text, description.text)) {
      return {
        code: "wrong-line",
        reason:
          `${role} capture misdescribed: ${slot.path}: the description says ` +
          `${JSON.stringify(description.text)} but the line is ${JSON.stringify(line.text)}`,
      };
    }
  }
  return null;
}

function normalizedWords(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function sameLine(intended: string, spoken: string): boolean {
  const left = normalizedWords(intended);
  const right = normalizedWords(spoken);
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/** A sample-exact window of a decoded file. Frames are per channel. */
function sliceAudio(audio: DecodedAudio, startFrame: number, frameCount: number): DecodedAudio {
  const channels = audio.facts.channels;
  const totalFrames = audio.facts.frameCount;
  const start = Math.max(0, Math.min(Math.round(startFrame), totalFrames));
  const count = Math.max(0, Math.min(Math.round(frameCount), totalFrames - start));
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

function onsetFrame(reading: Reading<{ seconds: number }>, sampleRate: number): number | null {
  return reading.measured ? Math.round(reading.value.seconds * sampleRate) : null;
}

type AlignedPair = {
  reference: DecodedAudio;
  delivered: DecodedAudio;
  onsetDeltaSeconds: number | null;
};

/**
 * Slice both captures to the same window. The line marker decides the window:
 * the greeting starts at the delivered onset, a marked segment starts where the
 * caller marked it. Both windows start at their own audible onset, so the
 * samples line up and a lead-in is a reported fact rather than a divergence.
 */
function alignPair(
  reference: DecodedAudio,
  delivered: DecodedAudio,
  line: TwoCaptureLine | null,
  reasons: string[],
): AlignedPair {
  if (line === null) {
    return { reference, delivered, onsetDeltaSeconds: null };
  }

  const toleranceFrames = Math.round(
    SCOREBOARD_BUDGETS.comparisonOnsetToleranceS.value * reference.facts.sampleRate,
  );
  const referenceOnset = measureOnset(reference);
  if (!referenceOnset.measured) {
    reasons.push(`reference has no audible onset: ${referenceOnset.reason}`);
    return { reference, delivered, onsetDeltaSeconds: null };
  }

  if (line.kind === "segment") {
    const start = line.startSeconds;
    const end = line.endSeconds;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > delivered.facts.durationSeconds + toleranceFrames / delivered.facts.sampleRate
    ) {
      reasons.push(
        `line marker invalid: segment ${start}..${end}s is outside the delivered capture ` +
          `(${delivered.facts.durationSeconds.toFixed(3)}s)`,
      );
      return { reference, delivered, onsetDeltaSeconds: null };
    }
    const segment = sliceAudio(
      delivered,
      Math.round(start * delivered.facts.sampleRate),
      Math.round((end - start) * delivered.facts.sampleRate),
    );
    return alignWindows(reference, segment, referenceOnset, reasons, toleranceFrames);
  }

  const deliveredOnset = measureOnset(delivered);
  if (!deliveredOnset.measured) {
    reasons.push(`delivered has no audible onset: ${deliveredOnset.reason}`);
    return { reference, delivered, onsetDeltaSeconds: null };
  }
  const referenceStart = onsetFrame(referenceOnset, reference.facts.sampleRate)!;
  const deliveredStart = onsetFrame(deliveredOnset, delivered.facts.sampleRate)!;
  const lineFrames = reference.facts.frameCount - referenceStart;
  if (lineFrames <= 0) {
    reasons.push("reference has no samples after its onset");
    return { reference, delivered, onsetDeltaSeconds: null };
  }
  const deltaSeconds = Math.abs(
    deliveredOnset.value.seconds - referenceOnset.value.seconds,
  );
  if (deltaSeconds * reference.facts.sampleRate > toleranceFrames) {
    reasons.push(
      `reference and delivered onsets differ by ${deltaSeconds.toFixed(3)} s, beyond the ` +
        `${SCOREBOARD_BUDGETS.comparisonOnsetToleranceS.value.toFixed(3)} s bar; a lead-in is reported, never blamed`,
    );
  }
  const deliveredRemaining = delivered.facts.frameCount - deliveredStart;
  if (deliveredRemaining < lineFrames - toleranceFrames) {
    const missing = (lineFrames - deliveredRemaining) / reference.facts.sampleRate;
    reasons.push(
      `delivered capture truncated: the greeting line needs ${(lineFrames / reference.facts.sampleRate).toFixed(3)} s ` +
        `after its onset but only ${(deliveredRemaining / delivered.facts.sampleRate).toFixed(3)} s is present (${missing.toFixed(3)} s short)`,
    );
  }
  const frames = Math.min(lineFrames, deliveredRemaining);
  return {
    reference: sliceAudio(reference, referenceStart, frames),
    delivered: sliceAudio(delivered, deliveredStart, frames),
    onsetDeltaSeconds: deltaSeconds,
  };
}

/** Align a reference and a marked delivered segment by their onsets. */
function alignWindows(
  reference: DecodedAudio,
  segment: DecodedAudio,
  referenceOnset: Reading<{ seconds: number }>,
  reasons: string[],
  toleranceFrames: number,
): AlignedPair {
  if (!referenceOnset.measured) {
    reasons.push(`reference has no audible onset: ${referenceOnset.reason}`);
    return { reference, delivered: segment, onsetDeltaSeconds: null };
  }
  const segmentOnset = measureOnset(segment);
  if (!segmentOnset.measured) {
    reasons.push(`marked segment has no audible onset: ${segmentOnset.reason}`);
    return { reference, delivered: segment, onsetDeltaSeconds: null };
  }
  const referenceStart = onsetFrame(referenceOnset, reference.facts.sampleRate)!;
  const segmentStart = onsetFrame(segmentOnset, segment.facts.sampleRate)!;
  const referenceFrames = reference.facts.frameCount - referenceStart;
  const segmentFrames = segment.facts.frameCount - segmentStart;
  if (Math.abs(referenceFrames - segmentFrames) > toleranceFrames) {
    reasons.push(
      `marked segment is ${(segmentFrames / segment.facts.sampleRate).toFixed(3)} s but the reference line is ` +
        `${(referenceFrames / reference.facts.sampleRate).toFixed(3)} s; a different line or a truncated capture is unresolved`,
    );
  }
  const deltaSeconds = Math.abs(
    segmentOnset.value.seconds - referenceOnset.value.seconds,
  );
  if (deltaSeconds * reference.facts.sampleRate > toleranceFrames) {
    reasons.push(
      `reference and marked segment onsets differ by ${deltaSeconds.toFixed(3)} s, beyond the ` +
        `${SCOREBOARD_BUDGETS.comparisonOnsetToleranceS.value.toFixed(3)} s bar`,
    );
  }
  const frames = Math.min(referenceFrames, segmentFrames);
  return {
    reference: sliceAudio(reference, referenceStart, frames),
    delivered: sliceAudio(segment, segmentStart, frames),
    onsetDeltaSeconds: deltaSeconds,
  };
}

// ── Client signatures and the pipeline audit ────────────────────────────────

/** The envelope frame the fade analyser reads; the breakup analyser's own 10 ms. */
const FADE_FRAME_SECONDS = 0.01;
/** A dip this many frames long is a fade; one frame is an edge, not a dip. */
const FADE_MIN_FRAMES = 2;
/** The analyser reports the whole dip, including the ramp either side. */
const FADE_RAMP_FRAMES = 2;
/** The breakups module's digital-silence floor: a fade never reaches it. */
const FADE_SILENCE_FLOOR_DBFS = -60;

function signatureBar(key: BudgetKey): SignatureThreshold {
  return { key, value: SCOREBOARD_BUDGETS[key].value, unit: SCOREBOARD_BUDGETS[key].unit };
}

function factFor(
  facts: readonly CaptureFacts<TwoCaptureRole>[],
  role: TwoCaptureRole,
): CaptureFacts<TwoCaptureRole> | null {
  return facts.find((capture) => capture.role === role) ?? null;
}

/** Mean-square level of each non-overlapping frame, in dBFS. */
function envelopeLevelsDb(audio: DecodedAudio, frameSamples: number): number[] {
  const { samples, facts } = audio;
  const { channels, frameCount } = facts;
  const frames = Math.ceil(frameCount / frameSamples);
  const levels = new Array<number>(frames);
  for (let frame = 0; frame < frames; frame++) {
    const first = frame * frameSamples;
    const last = Math.min(first + frameSamples, frameCount);
    let sumSquares = 0;
    for (let index = first; index < last; index++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = samples[index * channels + channel] / 32_768;
        sumSquares += sample * sample;
      }
    }
    const count = (last - first) * channels;
    levels[frame] =
      count === 0 ? -Infinity : 10 * Math.log10(sumSquares / count);
  }
  return levels;
}

function emptySignature(
  kind: ClientSignatureKind,
  reason: string,
): ClientSignature {
  return { kind, detected: false, value: 0, bar: null, intervals: [], detail: reason, reason };
}

/**
 * A short partial gain dip the reference does not have. Unlike an inserted
 * silence it never reaches digital silence, and unlike a level step it is
 * bounded on both sides: the delivered recovers to the reference's level.
 */
function boundaryFade(
  reference: DecodedAudio,
  delivered: DecodedAudio,
): ClientSignature {
  const bar = signatureBar("comparisonLevelLu");
  if (
    reference.facts.sampleRate !== delivered.facts.sampleRate ||
    reference.facts.channels !== delivered.facts.channels
  ) {
    return emptySignature(
      "boundary-fade",
      "the captures are not in one format, so a gain dip cannot be compared",
    );
  }
  const frameSamples = Math.max(1, Math.round(FADE_FRAME_SECONDS * reference.facts.sampleRate));
  const frameSeconds = frameSamples / reference.facts.sampleRate;
  const refLevels = envelopeLevelsDb(reference, frameSamples);
  const delLevels = envelopeLevelsDb(delivered, frameSamples);
  const count = Math.min(refLevels.length, delLevels.length);
  const intervals: SignatureInterval[] = [];
  let deepest = 0;

  let frame = 0;
  while (frame < count) {
    const referenceLevel = refLevels[frame];
    const deliveredLevel = delLevels[frame];
    const measurable =
      referenceLevel > FADE_SILENCE_FLOOR_DBFS && deliveredLevel > FADE_SILENCE_FLOOR_DBFS;
    const drop = measurable ? referenceLevel - deliveredLevel : -Infinity;
    if (drop < bar.value) {
      frame++;
      continue;
    }

    const start = frame;
    while (frame < count) {
      const refLevel = refLevels[frame];
      const delLevel = delLevels[frame];
      const stillMeasurable = refLevel > FADE_SILENCE_FLOOR_DBFS && delLevel > FADE_SILENCE_FLOOR_DBFS;
      if (!stillMeasurable || refLevel - delLevel < bar.value) break;
      frame++;
    }
    const end = frame;

    // A step that never recovers before the file ends is a level change, not a
    // bounded fade; the level check owns it. A fade recovers inside the file.
    const bounded = start > 0 && end < count;
    if (!bounded || end - start < FADE_MIN_FRAMES) continue;

    let peak = 0;
    for (let index = start; index < end; index++) {
      peak = Math.max(peak, refLevels[index] - delLevels[index]);
    }
    deepest = Math.max(deepest, peak);
    // Report the whole dip, not only the frames over the bar: the ramp either
    // side is part of the fade and must be masked out of the residual too.
    const maskStart = Math.max(0, start - FADE_RAMP_FRAMES);
    const maskEnd = Math.min(count, end + FADE_RAMP_FRAMES);
    intervals.push({
      startSeconds: maskStart * frameSeconds,
      seconds: (maskEnd - maskStart) * frameSeconds,
    });
  }

  if (intervals.length === 0) {
    return {
      kind: "boundary-fade",
      detected: false,
      value: 0,
      bar,
      intervals: [],
      detail: `no delivered frame dips more than ${bar.value.toFixed(1)} dB below the reference and recovers`,
      reason: null,
    };
  }
  return {
    kind: "boundary-fade",
    detected: true,
    value: Number(deepest.toFixed(2)),
    bar,
    intervals,
    detail:
      `${intervals.length} partial gain ${intervals.length === 1 ? "dip" : "dips"} the reference does not have ` +
      `(deepest ${deepest.toFixed(1)} dB, over the ${bar.value.toFixed(1)} dB bar)`,
    reason: null,
  };
}

function insertedSilence(
  reference: CaptureFacts<TwoCaptureRole>,
  delivered: CaptureFacts<TwoCaptureRole>,
): ClientSignature {
  const bar = signatureBar("comparisonBreakupCount");
  const match = SCOREBOARD_BUDGETS.timbreMeasuredBreakupMatchSeconds.value;
  if (!reference.breakups.measured) {
    return emptySignature(
      "inserted-silence",
      `the breakups could not be measured on the reference capture (${reference.breakups.reason})`,
    );
  }
  if (!delivered.breakups.measured) {
    return emptySignature(
      "inserted-silence",
      `the breakups could not be measured on the delivered capture (${delivered.breakups.reason})`,
    );
  }
  const referenceStarts = reference.breakups.value.breakups.map((entry) => entry.startSeconds);
  const unmatched = delivered.breakups.value.breakups.filter(
    (entry) => !referenceStarts.some((start) => Math.abs(start - entry.startSeconds) <= match),
  );
  const seconds = unmatched.reduce((sum, entry) => sum + entry.durationSeconds, 0);
  return {
    kind: "inserted-silence",
    detected: unmatched.length >= bar.value,
    value: unmatched.length,
    bar,
    intervals: unmatched.map((entry) => ({
      startSeconds: entry.startSeconds,
      seconds: entry.durationSeconds,
    })),
    detail:
      unmatched.length === 0
        ? "the delivered capture carries no inserted silence the reference does not have"
        : `the delivered capture adds ${unmatched.length} inserted ${
            unmatched.length === 1 ? "silence" : "silences"
          } (${seconds.toFixed(3)} s) the reference does not have`,
    reason: null,
  };
}

function chunkRateModulation(
  reference: CaptureFacts<TwoCaptureRole>,
  delivered: CaptureFacts<TwoCaptureRole>,
): ClientSignature {
  const bar = signatureBar("comparisonModulationDepth");
  if (!reference.modulation.measured) {
    return emptySignature(
      "chunk-rate-modulation",
      `the envelope could not be measured on the reference capture (${reference.modulation.reason})`,
    );
  }
  if (!delivered.modulation.measured) {
    return emptySignature(
      "chunk-rate-modulation",
      `the envelope could not be measured on the delivered capture (${delivered.modulation.reason})`,
    );
  }
  const delta = delivered.modulation.value.depth - reference.modulation.value.depth;
  const detected = delta > bar.value;
  return {
    kind: "chunk-rate-modulation",
    detected,
    value: Number(delta.toFixed(4)),
    bar,
    intervals: [],
    detail: detected
      ? `the delivered envelope swings ${(delta * 100).toFixed(1)} points deeper at ` +
        `${delivered.modulation.value.rateHz.toFixed(1)} Hz, over the ${(bar.value * 100).toFixed(0)}-point bar`
      : `the delivered envelope is within ${(bar.value * 100).toFixed(0)} points of the reference at ` +
        `${delivered.modulation.value.rateHz.toFixed(1)} Hz`,
    reason: null,
  };
}

/**
 * A fold, not a tilt: a band the reference does not carry appears lower in the
 * delivered capture while a band the reference carries disappears above it.
 * A re-encode or an octave tilt keeps both bands present at a moved level.
 */
function deviceRateAlias(
  reference: CaptureFacts<TwoCaptureRole>,
  delivered: CaptureFacts<TwoCaptureRole>,
): ClientSignature {
  if (!reference.spectrum.measured) {
    return emptySignature(
      "device-rate-alias",
      `the octave balance could not be measured on the reference capture (${reference.spectrum.reason})`,
    );
  }
  if (!delivered.spectrum.measured) {
    return emptySignature(
      "device-rate-alias",
      `the octave balance could not be measured on the delivered capture (${delivered.spectrum.reason})`,
    );
  }
  const referenceMissing = new Set(
    reference.spectrum.value.missingBands.map((band) => band.centreHz),
  );
  const deliveredMissing = new Set(
    delivered.spectrum.value.missingBands.map((band) => band.centreHz),
  );
  const gained = delivered.spectrum.value.bands.filter(
    (band) => !deliveredMissing.has(band.centreHz) && referenceMissing.has(band.centreHz),
  );
  const lost = reference.spectrum.value.bands.filter(
    (band) => !referenceMissing.has(band.centreHz) && deliveredMissing.has(band.centreHz),
  );
  const foldedDown =
    gained.length > 0 &&
    lost.length > 0 &&
    Math.max(...gained.map((band) => band.centreHz)) <
      Math.min(...lost.map((band) => band.centreHz));
  return {
    kind: "device-rate-alias",
    detected: foldedDown,
    value: foldedDown ? gained.length : 0,
    bar: null,
    intervals: [],
    detail: foldedDown
      ? `energy folded down: ${gained
          .map((band) => `${band.centreHz} Hz at ${band.levelDb.toFixed(1)} dBFS`)
          .join(", ")} appeared where the reference carried none, and ${lost
          .map((band) => `${band.centreHz} Hz`)
          .join(", ")} disappeared above it`
      : "no band moved down the spectrum while a higher band was lost",
    reason: null,
  };
}

function detectClientSignatures(
  reference: DecodedAudio | null,
  delivered: DecodedAudio | null,
  facts: readonly CaptureFacts<TwoCaptureRole>[],
): ClientSignature[] {
  const refFacts = factFor(facts, "reference");
  const delFacts = factFor(facts, "delivered");
  if (reference === null || delivered === null || refFacts === null || delFacts === null) {
    const reason = "both captures must be present and aligned before a client signature can be measured";
    return CLIENT_SIGNATURE_KINDS.map((kind) => emptySignature(kind, reason));
  }
  if (
    reference.facts.sampleRate !== delivered.facts.sampleRate ||
    reference.facts.channels !== delivered.facts.channels
  ) {
    const reason = "the captures are not in one format, so a client signature cannot be measured";
    return CLIENT_SIGNATURE_KINDS.map((kind) => emptySignature(kind, reason));
  }
  const silence = insertedSilence(refFacts, delFacts);
  const fade = boundaryFade(reference, delivered);
  // A periodic envelope swing is modulation, not a boundary fade; a single
  // bounded dip is a fade, not a periodic modulation. The two signatures are
  // separated by their shape, so neither steals the other's blame.
  const periodicSwing = fade.detected && fade.intervals.length > 2;
  const fadeReading = periodicSwing
    ? emptySignature(
        "boundary-fade",
        "the delivered envelope dips repeatedly; the chunk-rate modulation signature owns that swing",
      )
    : fade;
  const modulation = silence.detected
    ? emptySignature(
        "chunk-rate-modulation",
        "the inserted silence owns the envelope swing, so this is not a chunk-rate modulation",
      )
    : fadeReading.detected
      ? emptySignature(
          "chunk-rate-modulation",
          "the single bounded dip is the boundary-fade signature, not a periodic modulation",
        )
      : chunkRateModulation(refFacts, delFacts);
  return [
    silence,
    modulation,
    deviceRateAlias(refFacts, delFacts),
    fadeReading,
  ];
}

/** Zero the same frames in both captures, so client damage is not read as signal. */
function maskIntervals(
  audio: DecodedAudio,
  intervals: readonly SignatureInterval[],
): DecodedAudio {
  if (intervals.length === 0) return audio;
  const samples = audio.samples.slice();
  const { sampleRate, channels, frameCount } = audio.facts;
  for (const interval of intervals) {
    const start = Math.max(0, Math.round(interval.startSeconds * sampleRate));
    const end = Math.min(frameCount, start + Math.round(interval.seconds * sampleRate));
    for (let frame = start; frame < end; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        samples[frame * channels + channel] = 0;
      }
    }
  }
  return { samples, facts: audio.facts };
}

function buildPipelineAudit(
  reference: DecodedAudio | null,
  delivered: DecodedAudio | null,
  facts: readonly CaptureFacts<TwoCaptureRole>[],
  signatures: readonly ClientSignature[],
  spectral: SpectralContext,
): W0PipelineAudit {
  const unmeasured = (reason: string): W0PipelineAudit => ({
    reason,
    masked: [],
    clientOwned: [],
    level: { measured: false, reason },
    peak: { measured: false, reason },
    distortion: { measured: false, reason },
    spectrum: { measured: false, reason },
    crest: { measured: false, reason },
  });

  if (reference === null || delivered === null) {
    return unmeasured("both captures must be present and aligned before the pipeline axes can be compared");
  }
  if (
    reference.facts.sampleRate !== delivered.facts.sampleRate ||
    reference.facts.channels !== delivered.facts.channels
  ) {
    return unmeasured("the captures are not in one format, so the pipeline axes are not comparable");
  }

  const maskable = signatures
    .filter((signature) => signature.detected && signature.intervals.length > 0)
    .flatMap((signature) => signature.intervals);
  const maskedReference = maskIntervals(reference, maskable);
  const maskedDelivered = maskIntervals(delivered, maskable);
  const alias = signatures.find((signature) => signature.kind === "device-rate-alias");
  const modulation = signatures.find((signature) => signature.kind === "chunk-rate-modulation");
  const aliasOwnsTheSpectrum = alias?.detected === true;
  const modulationOwnsTheResidual = modulation?.detected === true;
  const clientOwned: W0PipelineAudit["clientOwned"] = [
    ...(aliasOwnsTheSpectrum ? (["spectrum", "distortion"] as const) : []),
    ...(modulationOwnsTheResidual ? (["distortion"] as const) : []),
  ];

  const levelReading = (audio: DecodedAudio): Reading<Extract<LevelFacts, { measured: true }>> => {
    try {
      const reading = analyseLevel(audio);
      return reading.measured
        ? { measured: true, value: reading }
        : { measured: false, reason: `no measurable level (${reading.absence})` };
    } catch (error) {
      if (error instanceof LevelFactsError) return { measured: false, reason: error.message };
      throw error;
    }
  };

  const referenceLevel = levelReading(maskedReference);
  const deliveredLevel = levelReading(maskedDelivered);

  const level: W0PipelineAudit["level"] =
    referenceLevel.measured && deliveredLevel.measured
      ? {
          measured: true,
          value: {
            referenceLufs: referenceLevel.value.integratedLufs,
            deliveredLufs: deliveredLevel.value.integratedLufs,
            deltaLu: deliveredLevel.value.integratedLufs - referenceLevel.value.integratedLufs,
          },
        }
      : {
          measured: false,
          reason:
            `level is unmeasured on the ` +
            `${referenceLevel.measured ? "delivered" : "reference"} capture (` +
            `${referenceLevel.measured ? (deliveredLevel as { reason: string }).reason : (referenceLevel as { reason: string }).reason})`,
        };

  const peak: W0PipelineAudit["peak"] =
    referenceLevel.measured && deliveredLevel.measured
      ? {
          measured: true,
          value: {
            referenceDbtp: referenceLevel.value.truePeakDbtp,
            deliveredDbtp: deliveredLevel.value.truePeakDbtp,
          },
        }
      : { measured: false, reason: level.measured ? "level is unmeasured" : level.reason };

  const distortion: W0PipelineAudit["distortion"] = modulationOwnsTheResidual
    ? {
        measured: false,
        reason:
          "the client's chunk-rate modulation imitates a residual, so a delivered residual " +
          "cannot separate the server's audio from the client's playback",
      }
    : aliasOwnsTheSpectrum
      ? {
          measured: false,
          reason:
            "the device-rate alias folds the spectrum, so a delivered residual cannot separate " +
            "the server's audio from the client's playback",
        }
      : (() => {
          try {
            return {
              measured: true as const,
              value: { residualDb: distortionResidual(maskedReference, maskedDelivered).residualDb },
            };
          } catch (error) {
            if (error instanceof DistortionCrestError) {
              return { measured: false as const, reason: error.message };
            }
            throw error;
          }
        })();

  const spectrum: W0PipelineAudit["spectrum"] = aliasOwnsTheSpectrum
    ? {
        measured: false,
        reason:
          "the device-rate alias owns the octave bands it moved, so the server-side balance " +
          "cannot be separated from the client's fold",
      }
    : (() => {
        if (spectral.tilt === null) {
          return { measured: false as const, reason: "needs two octave bands to quote a balance" };
        }
        try {
          const referenceBalance = measureSpectralBalance(maskedReference, {
            centresHz: spectral.bands,
            tilt: spectral.tilt,
          });
          const deliveredBalance = measureSpectralBalance(maskedDelivered, {
            centresHz: spectral.bands,
            tilt: spectral.tilt,
          });
          return {
            measured: true as const,
            value: {
              referenceDeltaDb: referenceBalance.tilt.deltaDb,
              deliveredDeltaDb: deliveredBalance.tilt.deltaDb,
              deltaDb: deliveredBalance.tilt.deltaDb - referenceBalance.tilt.deltaDb,
            },
          };
        } catch (error) {
          if (error instanceof RangeError) return { measured: false as const, reason: error.message };
          throw error;
        }
      })();

  const crest: W0PipelineAudit["crest"] = (() => {
    const referenceCrest = crestFactor(maskedReference);
    const deliveredCrest = crestFactor(maskedDelivered);
    if (!Number.isFinite(referenceCrest.crestFactor) || !Number.isFinite(deliveredCrest.crestFactor)) {
      return { measured: false as const, reason: "a silent signal has no crest factor" };
    }
    return {
      measured: true as const,
      value: {
        reference: referenceCrest.crestFactor,
        delivered: deliveredCrest.crestFactor,
      },
    };
  })();

  return {
    reason: null,
    masked: maskable,
    clientOwned,
    level,
    peak,
    distortion,
    spectrum,
    crest,
  };
}


export function compareReferenceAndDelivered(
  input: TwoCaptureRequest,
): TwoCaptureComparison {
  // The cascade has no gain stage: a level knob on the request is refused by
  // name before any sample is read, so a comparison can only be native.
  assertNoLevelStage(input as unknown as Record<string, unknown>, "comparison request");
  const reasons: string[] = [];
  const toleranceSeconds = SCOREBOARD_BUDGETS.comparisonOnsetToleranceS.value;
  const slots: Record<TwoCaptureRole, TwoCaptureSlot | null> = {
    reference: input.reference,
    delivered: input.delivered,
  };

  if (input.line === null) {
    reasons.push(
      "no line marker: a whole-call capture is incomplete; the greeting line or a marked segment is required",
    );
  } else if (input.spokenLine !== undefined && !sameLine(input.line.text, input.spokenLine)) {
    reasons.push(
      `different line: the reference renders ${JSON.stringify(input.line.text)} but the transcript says ` +
        `${JSON.stringify(input.spokenLine)}`,
    );
  }

  const captureProblems = {} as Record<TwoCaptureRole, TwoCaptureProblem | null>;
  for (const role of TWO_CAPTURE_ROLES) {
    captureProblems[role] = captureProblem(
      role,
      slots[role],
      input.line,
      input.expectedFormat,
    );
  }

  const captureHeaders: TwoCaptureCapture[] = TWO_CAPTURE_ROLES.map((role) => {
    const slot = slots[role];
    const problem = captureProblems[role];
    if (problem !== null) reasons.push(problem.reason);
    return {
      role,
      path: slot?.path ?? "(no path)",
      present: problem === null,
      reason: problem?.reason ?? null,
      problem,
    };
  });

  // A capture the profile refuses is not measured at all: a header-only or
  // stereo file must not contribute a number that could be read as evidence.
  const reference =
    captureProblems.reference === null && isDecoded(slots.reference)
      ? slots.reference.audio
      : null;
  const delivered =
    captureProblems.delivered === null && isDecoded(slots.delivered)
      ? slots.delivered.audio
      : null;

  let alignedReference = reference;
  let alignedDelivered = delivered;
  let onsetDeltaSeconds: number | null = null;

  if (reference && delivered) {
    const sameFormat =
      reference.facts.sampleRate === delivered.facts.sampleRate &&
      reference.facts.channels === delivered.facts.channels;
    if (!sameFormat) {
      reasons.push(
        `format mismatch: reference is ${reference.facts.sampleRate} Hz x${reference.facts.channels}ch, ` +
          `delivered is ${delivered.facts.sampleRate} Hz x${delivered.facts.channels}ch; resample or refuse, never guess`,
      );
    } else {
      const aligned = alignPair(reference, delivered, input.line, reasons);
      alignedReference = aligned.reference;
      alignedDelivered = aligned.delivered;
      onsetDeltaSeconds = aligned.onsetDeltaSeconds;
    }
  }

  const present = [
    ...(alignedReference
      ? [{ role: "reference" as const, path: slots.reference!.path, audio: alignedReference }]
      : []),
    ...(alignedDelivered
      ? [{ role: "delivered" as const, path: slots.delivered!.path, audio: alignedDelivered }]
      : []),
  ];
  const spectral = spectralContextFor(present);
  const facts = measureFacts(present, spectral);
  if (reference === null) {
    // Distortion is relative: with no reference there is no baseline, so the
    // delivered column says why instead of reporting zero against itself.
    const missing = captureProblems.reference?.reason ?? "reference capture is not comparable";
    for (const fact of facts) {
      fact.distortion = { kind: "unmeasured", reason: missing };
    }
  }
  const rowCaptures: RowCapture<TwoCaptureRole>[] = TWO_CAPTURE_ROLES.map((role) => {
    const fact = facts.find((capture) => capture.role === role);
    if (fact) return fact;
    return {
      role,
      missingReason: captureProblems[role]?.reason ?? `${role} capture is not comparable`,
    };
  });
  const rows = buildRows(TWO_CAPTURE_ROLES, rowCaptures, spectral);

  // The client signatures are measured on the aligned pair; the pipeline audit
  // then removes the windows those signatures own, so a playback hole or fade
  // cannot be re-read as a server-side level or residual defect.
  const clientSignatures = detectClientSignatures(alignedReference, alignedDelivered, facts);
  const pipeline = buildPipelineAudit(
    alignedReference,
    alignedDelivered,
    facts,
    clientSignatures,
    spectral,
  );

  const withinTolerance =
    onsetDeltaSeconds === null ? null : onsetDeltaSeconds <= toleranceSeconds;
  return {
    profile: "w0-two-capture",
    status: reasons.length === 0 ? "measured" : "unresolved",
    unresolvedReasons: reasons,
    gainStage: NATIVE_GAIN_STAGE,
    line: input.line,
    alignment: {
      onsetDeltaSeconds,
      toleranceSeconds,
      withinTolerance,
      sampleAligned:
        input.line !== null &&
        reference !== null &&
        delivered !== null &&
        reference.facts.sampleRate === delivered.facts.sampleRate &&
        reference.facts.channels === delivered.facts.channels &&
        withinTolerance === true,
    },
    captures: captureHeaders,
    octaveBandsHz: spectral.bands,
    tilt: spectral.tilt,
    rows,
    clientSignatures,
    pipeline,
  };
}

/** One cell as text. A value is fixed to the row's decimals, signed if a delta. */
export function formatCell(cell: ComparisonCell, decimals: number, signed = false): string {
  if (cell.kind === "value") {
    const text = cell.value.toFixed(decimals);
    // "-0.00" is a rounding artifact, not a negative measurement.
    const normalized = /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
    return signed && !normalized.startsWith("-") ? `+${normalized}` : normalized;
  }
  if (cell.kind === "text") return cell.text;
  return `unmeasured: ${cell.reason}`;
}

type RenderableCapture<Role extends string> = {
  role: Role;
  path: string;
  /** Appended to the column's file line, e.g. why a capture is missing. */
  note?: string | null;
};

/**
 * Render a comparison as a deterministic aligned table. File paths, rows and
 * rounding are fixed, so the same files print the same table twice. The
 * producer legend names the module behind every metric, so a number in the
 * table is always attributable to an implementation.
 */
function renderComparisonTable<Role extends string>(opts: {
  title: string;
  roles: readonly Role[];
  captures: readonly RenderableCapture<Role>[];
  rows: readonly ComparisonRow<Role>[];
}): string {
  const { title, roles, captures, rows } = opts;
  const labelWidth = Math.max(5, rows.reduce((width, row) => Math.max(width, row.label.length), 0));
  const columnWidths = roles.map((role) =>
    rows.reduce(
      (width, row) => Math.max(width, formatCell(row.cells[role], row.decimals, row.signed).length),
      role.length,
    ),
  );

  const line = (label: string, cells: readonly string[]): string =>
    (
      `    ${label.padEnd(labelWidth)}  ` +
      cells.map((cell, index) => cell.padEnd(columnWidths[index])).join("  ")
    ).trimEnd();

  const header = line("metric", roles);
  const separator = "    " + "-".repeat(header.length - 4);
  const lines: string[] = [
    title,
    ...captures.map(
      (capture) =>
        `  ${capture.role.padEnd(10)} ${capture.path}${capture.note ? ` (${capture.note})` : ""}`,
    ),
    "",
    header,
    separator,
  ];

  for (const group of COMPARISON_GROUPS) {
    const grouped = rows.filter((row) => row.group === group);
    if (grouped.length === 0) continue;
    lines.push(`  ${group}`);
    for (const row of grouped) {
      lines.push(
        line(
          row.label,
          roles.map((role) => formatCell(row.cells[role], row.decimals, row.signed)),
        ),
      );
    }
  }

  const producers = [...new Set(rows.map((row) => row.producer))].sort();
  if (producers.length > 0) {
    lines.push("", "  producers");
    for (const producer of producers) lines.push(`    ${producer}`);
  }
  return lines.join("\n");
}

/**
 * Render the three-way comparison. Kept identical to the pre-cascade output so
 * existing evidence and tests read the same table.
 */
export function formatComparisonTable(comparison: AudioComparison): string {
  return renderComparisonTable({
    title: "Voice-parity audio comparison",
    roles: CAPTURE_ROLES,
    captures: comparison.captures.map((capture) => ({ role: capture.role, path: capture.path })),
    rows: comparison.rows,
  });
}

/** Render the W0 two-capture comparison, with no platform column. */
export function formatTwoCaptureTable(comparison: TwoCaptureComparison): string {
  const table = renderComparisonTable({
    title: "W0 two-capture comparison",
    roles: TWO_CAPTURE_ROLES,
    captures: comparison.captures.map((capture) => ({
      role: capture.role,
      path: capture.path,
      note: capture.present ? null : capture.reason,
    })),
    rows: comparison.rows,
  });
  // A reader must see the status beside the numbers: an unresolved comparison
  // is never printed in a shape that could be read as a pass.
  const lines = [
    table,
    "",
    `  status    ${comparison.status}`,
    ...comparison.unresolvedReasons.map((reason) => `    - ${reason}`),
  ];
  return lines.join("\n");
}
