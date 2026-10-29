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
 * This module never decides which layer is at fault.
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

export type ComparisonRow = {
  id: ComparisonRowId;
  group: ComparisonGroup;
  /** Printed at the left of the row. A per-band row carries its centre. */
  label: string;
  /** Decimal places for a numeric value; ignored by text and unmeasured. */
  decimals: number;
  /** A delta keeps its direction in the sign, so a tilt never reads unsigned. */
  signed?: boolean;
  cells: Record<CaptureRole, ComparisonCell>;
};

/** A metric the file cannot carry, named rather than guessed. */
export type Reading<T> = { measured: true; value: T } | { measured: false; reason: string };

/** Distortion is relative, so the reference is a baseline, not a reading. */
export type DistortionReading =
  | { kind: "baseline" }
  | { kind: "measured"; residual: DistortionResidual }
  | { kind: "unmeasured"; reason: string };

export type CaptureFacts = {
  role: CaptureRole;
  path: string;
  format: DecodedAudio["facts"];
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

function emptyCells(): Record<CaptureRole, ComparisonCell> {
  return {
    reference: { kind: "unmeasured", reason: "not measured" },
    platform: { kind: "unmeasured", reason: "not measured" },
    delivered: { kind: "unmeasured", reason: "not measured" },
  };
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

function formatRows(captures: readonly CaptureFacts[]): ComparisonRow[] {
  const row = (
    id: ComparisonRowId,
    label: string,
    decimals: number,
    pick: (capture: CaptureFacts) => number,
  ): ComparisonRow => {
    const cells = emptyCells();
    for (const capture of captures) {
      cells[capture.role] = { kind: "value", value: pick(capture) };
    }
    return { id, group: "format", label, decimals, cells };
  };

  return [
    row("sample-rate", "sample rate (Hz)", 0, (capture) => capture.format.sampleRate),
    row("channels", "channels", 0, (capture) => capture.format.channels),
    row("duration", "duration (s)", 2, (capture) => capture.format.durationSeconds),
    row("byte-rate", "byte rate (B/s)", 0, (capture) => capture.format.byteRate),
  ];
}

type MeasuredLevel = Extract<LevelFacts, { measured: true }>;

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
function readingRow<T>(
  captures: readonly CaptureFacts[],
  group: ComparisonGroup,
  id: ComparisonRowId,
  label: string,
  decimals: number,
  reading: (capture: CaptureFacts) => Reading<T>,
  pick: (value: T) => number,
): ComparisonRow {
  const cells = emptyCells();
  for (const capture of captures) {
    const value = reading(capture);
    cells[capture.role] = value.measured
      ? { kind: "value", value: pick(value.value) }
      : { kind: "unmeasured", reason: value.reason };
  }
  return { id, group, label, decimals, cells };
}

function levelRows(captures: readonly CaptureFacts[]): ComparisonRow[] {
  const level = (capture: CaptureFacts) => capture.level;
  return [
    readingRow(captures, "level", "integrated", "integrated (LUFS)", 2, level, (facts) => facts.integratedLufs),
    readingRow(captures, "level", "rms", "RMS (dBFS)", 2, level, (facts) => facts.rmsDbfs),
    readingRow(captures, "level", "true-peak", "true peak (dBTP)", 2, level, (facts) => facts.truePeakDbtp),
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
  reference: CaptureInput,
  capture: CaptureInput,
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

function shapeRows(captures: readonly CaptureFacts[]): ComparisonRow[] {
  const distortion = emptyCells();
  const crest = emptyCells();
  for (const capture of captures) {
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
    { id: "distortion", group: "shape", label: "distortion vs reference (dB)", decimals: 1, cells: distortion },
    { id: "crest", group: "shape", label: "crest factor (peak/RMS)", decimals: 3, cells: crest },
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

function breakupRows(captures: readonly CaptureFacts[]): ComparisonRow[] {
  const breakups = (capture: CaptureFacts) => capture.breakups;
  return [
    readingRow(captures, "breakups", "breakup-count", "breakup count", 0, breakups, (report) => report.count),
    readingRow(captures, "breakups", "breakup-total", "breakup total silence (s)", 3, breakups, (report) => report.totalSeconds),
    readingRow(captures, "breakups", "breakup-longest", "breakup longest silence (s)", 3, breakups, (report) => report.longestSeconds),
  ];
}

function spectrumRows(
  captures: readonly CaptureFacts[],
  context: SpectralContext,
): ComparisonRow[] {
  const cellFor = (
    capture: CaptureFacts,
    pick: (spectrum: SpectralBalance) => number,
  ): ComparisonCell => {
    if (!capture.spectrum.measured) {
      return { kind: "unmeasured", reason: capture.spectrum.reason };
    }
    return { kind: "value", value: pick(capture.spectrum.value) };
  };

  const bandRows: ComparisonRow[] = context.bands.map((centreHz) => {
    const cells = emptyCells();
    for (const capture of captures) {
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
      cells,
    };
  });

  const spread = emptyCells();
  const delta = emptyCells();
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
    { id: "band-spread", group: "spectrum", label: "band spread (dB)", decimals: 1, cells: spread },
    {
      id: "band-delta",
      group: "spectrum",
      label: tiltLabel,
      decimals: 1,
      signed: true,
      cells: delta,
    },
  ];
}

function modulationRows(captures: readonly CaptureFacts[]): ComparisonRow[] {
  const modulation = (capture: CaptureFacts) => capture.modulation;
  return [
    readingRow(captures, "modulation", "modulation-rate", "modulation rate (Hz)", 1, modulation, (reading) => reading.rateHz),
    readingRow(captures, "modulation", "modulation-depth", "modulation depth (%)", 1, modulation, (reading) => reading.depth * 100),
  ];
}

/** Measure the three captures and build every table row. Pure over its input. */
export function compareCaptures(inputs: readonly CaptureInput[]): AudioComparison {
  const ordered = orderCaptures(inputs);
  const commonBands = ordered
    .map((input) => availableBands(input.audio.facts.sampleRate))
    .reduce((shared, bands) => shared.filter((centre) => bands.includes(centre)));
  const spectral: SpectralContext = { bands: commonBands, tilt: tiltPairFor(commonBands) };

  const captures: CaptureFacts[] = ordered.map((input) => ({
    role: input.role,
    path: input.path,
    format: input.audio.facts,
    level: measureLevel(input.audio),
    distortion: measureDistortion(ordered[0], input),
    crest: measureCrest(input.audio),
    spectrum: measureSpectrum(input.audio, spectral),
    modulation: measureModulation(input.audio),
    breakups: measureBreakups(input.audio),
  }));

  const rows = [
    ...formatRows(captures),
    ...levelRows(captures),
    ...shapeRows(captures),
    ...spectrumRows(captures, spectral),
    ...modulationRows(captures),
    ...breakupRows(captures),
  ];
  return {
    captures,
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

/**
 * Render the comparison as a deterministic aligned table. File paths, rows and
 * rounding are fixed, so the same three files print the same table twice.
 */
export function formatComparisonTable(comparison: AudioComparison): string {
  const roles = CAPTURE_ROLES;
  const labelWidth = Math.max(
    5,
    comparison.rows.reduce((width, row) => Math.max(width, row.label.length), 0),
  );
  const columnWidths = roles.map((role) =>
    comparison.rows.reduce(
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
    "Voice-parity audio comparison",
    ...comparison.captures.map((capture) => `  ${capture.role.padEnd(10)} ${capture.path}`),
    "",
    header,
    separator,
  ];

  for (const group of COMPARISON_GROUPS) {
    const rows = comparison.rows.filter((row) => row.group === group);
    if (rows.length === 0) continue;
    lines.push(`  ${group}`);
    for (const row of rows) {
      lines.push(
        line(
          row.label,
          roles.map((role) => formatCell(row.cells[role], row.decimals, row.signed)),
        ),
      );
    }
  }

  return lines.join("\n");
}
