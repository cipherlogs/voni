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
import {
  SPEECH_OCTAVE_CENTRES,
  measureSpectralBalance,
  type SpectralBalance,
} from "./spectral-balance";
import { SCOREBOARD_BUDGETS } from "../demo/scoreboard-budgets";

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

/** A decoded capture. Decoding happens before the table is built. */
export type TwoCaptureDecoded = { path: string; audio: DecodedAudio };

/** A capture that could not be compared, named by what went wrong. */
export type TwoCaptureFailure = {
  path: string;
  reason: string;
  /** Defaults to `unreadable`; a caller may name a missing or truncated file. */
  kind?: "missing" | "truncated" | "unreadable";
};

export type TwoCaptureSlot = TwoCaptureDecoded | TwoCaptureFailure;

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
};

export type TwoCaptureCapture = {
  role: TwoCaptureRole;
  path: string;
  present: boolean;
  /** Why the capture is not present; null when it is. */
  reason: string | null;
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
};

function isDecoded(slot: TwoCaptureSlot | null): slot is TwoCaptureDecoded {
  return slot !== null && "audio" in slot;
}

function failureReason(role: TwoCaptureRole, slot: TwoCaptureSlot | null): string {
  if (slot === null) return `${role} capture missing: no file supplied`;
  if (isDecoded(slot)) return `${role} capture is present`;
  const kind = slot.kind ?? "unreadable";
  return `${role} capture ${kind}: ${slot.path}: ${slot.reason}`;
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

/**
 * Compare a reference rendering with a delivered capture, and nothing else.
 *
 * Pure over decoded audio: the caller owns file reading, so a saved capture can
 * be re-analysed without a browser or a network. A missing, truncated,
 * unreadable or format-mismatched capture is `unresolved`, never a pass; the
 * rows still print what each file could carry, so the cause is visible beside
 * the numbers.
 */
export function compareReferenceAndDelivered(
  input: TwoCaptureRequest,
): TwoCaptureComparison {
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

  const captureHeaders: TwoCaptureCapture[] = TWO_CAPTURE_ROLES.map((role) => {
    const slot = slots[role];
    const present = isDecoded(slot);
    const reason = present ? null : failureReason(role, slot);
    if (!present) reasons.push(reason!);
    return { role, path: slot?.path ?? "(no path)", present, reason };
  });

  const reference = isDecoded(slots.reference) ? slots.reference.audio : null;
  const delivered = isDecoded(slots.delivered) ? slots.delivered.audio : null;

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
    for (const fact of facts) {
      fact.distortion = {
        kind: "unmeasured",
        reason: failureReason("reference", slots.reference),
      };
    }
  }
  const rowCaptures: RowCapture<TwoCaptureRole>[] = TWO_CAPTURE_ROLES.map((role) => {
    const fact = facts.find((capture) => capture.role === role);
    if (fact) return fact;
    return { role, missingReason: failureReason(role, slots[role]) };
  });
  const rows = buildRows(TWO_CAPTURE_ROLES, rowCaptures, spectral);

  const withinTolerance =
    onsetDeltaSeconds === null ? null : onsetDeltaSeconds <= toleranceSeconds;
  return {
    profile: "w0-two-capture",
    status: reasons.length === 0 ? "measured" : "unresolved",
    unresolvedReasons: reasons,
    gainStage: "none",
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
  return renderComparisonTable({
    title: "W0 two-capture comparison",
    roles: TWO_CAPTURE_ROLES,
    captures: comparison.captures.map((capture) => ({
      role: capture.role,
      path: capture.path,
      note: capture.present ? null : capture.reason,
    })),
    rows: comparison.rows,
  });
}
