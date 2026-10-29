/**
 * Floor mode: a subject clears the vendor floor when it is at least as good on
 * every measured axis, not when it is merely different from before.
 *
 * The floor (ticket 18) is a committed capture of the vendor's own rendering of
 * one line in one voice. A subject is one delivered capture of that same line
 * plus the reference rendering it should be a faithful copy of. Five axes are
 * measured, each with one stated direction, because a diff of numbers cannot
 * tell "worse" from "different" on its own:
 *
 * | axis | compared | worse when |
 * | --- | --- | --- |
 * | `level` | delivered integrated loudness against the floor's | the deviation exceeds {@link FLOOR_AXIS_THRESHOLDS.levelDeviationLu} in **either** direction: a level contract is a target, so too loud (clipping) and too quiet (unintelligible) are both worse |
 * | `peak` | delivered true-peak headroom (`-dBTP`) against the floor's | the subject has **less** headroom than the floor; a more negative dBTP is more headroom and therefore better |
 * | `distortion` | delivered residual against its own reference, against the floor's residual against the same reference | the subject's residual is **larger**: a larger residual is more reshaping |
 * | `breakups` | delivered inserted silence against the floor's | the subject has **more** breakups, more total inserted silence or a longer one: a hole is never better than no hole |
 * | `modulation` | delivered envelope depth against the floor's | the subject's swing is **deeper**: a deeper periodic swing is the robotic texture the floor does not have |
 *
 * Two directions need explaining, because the obvious reading is wrong:
 *
 * - **True peak.** dBTP is a negative number and "higher" dBTP means closer to
 *   full scale, which is *less* headroom. The axis therefore compares
 *   `-truePeakDbtp`, so "higher is better" is about headroom, not about the raw
 *   reading.
 * - **Level.** There is no better side of a level target. A subject 3 LU
 *   quieter is not "different but equal", it is a subject the caller has to
 *   reach for the volume to hear. The axis is a match axis: within tolerance is
 *   `equal`, outside it is `worse`.
 *
 * Measurements come from the same pure modules the comparison uses
 * (`level-facts`, `distortion-crest`, `breakups`, `envelope-modulation`), so a
 * saved subject can be re-judged without a browser, network or database. A
 * metric a file cannot carry is `unmeasured`, and an `unmeasured` axis blocks a
 * pass: the verdict is `pass`, `fail` or `inconclusive`, and only `pass` clears
 * the floor. Every tolerance here is a record in `scoreboard-budgets.ts`
 * (`floor*`), which quotes the metric module that first published it; the
 * freeze guard pins the records, so a retune is a spec change, not a local
 * edit.
 *
 * This module is deliberately separate from the three-way first-divergence
 * verdict: floor mode answers "is this subject at least as good as the vendor",
 * which is a different question from "which layer diverged first".
 */
import { SCOREBOARD_BUDGETS } from "../demo/scoreboard-budgets";
import { detectBreakups, type BreakupReport } from "./breakups";
import { DistortionCrestError, distortionResidual } from "./distortion-crest";
import { measureEnvelopeModulation, type EnvelopeModulation } from "./envelope-modulation";
import type { DecodedAudio } from "./format-facts";
import { LevelFactsError, analyseLevel, type LevelFacts } from "./level-facts";
import type { VendorFloorProvenance } from "./vendor-floor";

export type FloorAxis = "level" | "peak" | "distortion" | "breakups" | "modulation";

/** The axes in table order. */
export const FLOOR_AXES: readonly FloorAxis[] = [
  "level",
  "peak",
  "distortion",
  "breakups",
  "modulation",
];

/**
 * Which side of each axis is worse, stated once so no reader has to infer a
 * sign from a number. Behaviour is pinned by the floor-mode tests in both
 * directions.
 */
export const FLOOR_AXIS_DIRECTIONS: Readonly<Record<FloorAxis, string>> = {
  level:
    "two-sided: integrated loudness is a target, so a deviation either side of the floor's is worse — too loud clips, too quiet is unintelligible",
  peak:
    "monotone in headroom: less true-peak headroom than the floor is worse, and a more negative dBTP is more headroom, so lower dBTP is better",
  distortion:
    "monotone: a larger residual against the subject's own reference than the floor's residual against the same reference is worse",
  breakups:
    "monotone: more inserted silence (count, total or longest) than the floor is worse; a hole is never better than no hole",
  modulation:
    "monotone: a deeper periodic envelope swing than the floor's is worse; a deeper swing is the robotic texture the floor does not have",
};

/**
 * Every tolerance floor mode uses, read from the frozen budget table. The
 * budget record's `source` names the metric module each bar quotes, so this
 * module owns no threshold of its own.
 */
export const FLOOR_AXIS_THRESHOLDS = {
  levelDeviationLu: SCOREBOARD_BUDGETS.floorLevelDeviationLu.value,
  peakHeadroomDb: SCOREBOARD_BUDGETS.floorPeakHeadroomDb.value,
  distortionResidualDb: SCOREBOARD_BUDGETS.floorDistortionResidualDb.value,
  breakupSeconds: SCOREBOARD_BUDGETS.floorBreakupSeconds.value,
  modulationDepth: SCOREBOARD_BUDGETS.floorModulationDepth.value,
} as const;

/**
 * `better`/`worse` are the two sides of an axis' direction, `equal` is inside
 * the axis tolerance, and `unmeasured` means the file cannot carry the metric —
 * which is never a pass.
 */
export type FloorAxisStanding = "better" | "equal" | "worse" | "unmeasured";

export type FloorAxisReading = {
  axis: FloorAxis;
  /** What the axis compares, in the axis' own units. */
  label: string;
  /** Which side is worse, copied from {@link FLOOR_AXIS_DIRECTIONS}. */
  direction: string;
  standing: FloorAxisStanding;
  /** The subject's measurement, or `null` when unmeasured. */
  subject: number | null;
  /** The floor's measurement, or `null` when unmeasured. */
  floor: number | null;
  /** The sentence for this axis: both values, the bar and why it is worse. */
  detail: string;
};

/** A floor as the comparison reads it: the loaded evidence, or a test double. */
export type FloorReference = {
  path: string;
  audio: DecodedAudio;
  provenance?: Pick<VendorFloorProvenance, "voice" | "locale" | "line" | "capturedOn">;
};

/** A subject is the delivered capture and the reference it should copy. */
export type FloorSubject = {
  reference: { path: string; audio: DecodedAudio };
  delivered: { path: string; audio: DecodedAudio };
};

export type FloorVerdict = "pass" | "fail" | "inconclusive";

export type FloorComparison = {
  floor: {
    path: string;
    voice: string | null;
    locale: string | null;
    line: string | null;
    capturedOn: string | null;
  };
  subject: { path: string; referencePath: string };
  /** Every axis in {@link FLOOR_AXES} order. */
  axes: FloorAxisReading[];
  /** The axes on which the subject is worse, in axis order. */
  worse: FloorAxisReading[];
  /** The axes the subject's file could not carry, in axis order. */
  unmeasured: FloorAxisReading[];
  verdict: FloorVerdict;
  /** One sentence naming the worse axes, or citing the floor on a pass. */
  summary: string;
};

type MeasuredLevel = Extract<LevelFacts, { measured: true }>;

type AxisInput = {
  floor: FloorReference;
  subject: FloorSubject;
  floorLevel: { measured: true; value: MeasuredLevel } | { measured: false; reason: string };
  subjectLevel: { measured: true; value: MeasuredLevel } | { measured: false; reason: string };
};

function measuredLevel(audio: DecodedAudio): AxisInput["floorLevel"] {
  try {
    const facts = analyseLevel(audio);
    return facts.measured
      ? { measured: true, value: facts }
      : { measured: false, reason: `no measurable level (${facts.absence})` };
  } catch (error) {
    if (error instanceof LevelFactsError) return { measured: false, reason: error.message };
    throw error;
  }
}

function measuredModulation(audio: DecodedAudio): EnvelopeModulation | null {
  try {
    return measureEnvelopeModulation(audio);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function measuredBreakups(audio: DecodedAudio): BreakupReport | null {
  try {
    return detectBreakups(audio);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function db(value: number): string {
  if (value === -Infinity) return "no residual";
  if (value === Infinity) return "no delivered signal";
  return `${value.toFixed(1)} dB`;
}

function lufs(value: number): string {
  return `${value.toFixed(2)} LUFS`;
}

function dbtp(value: number): string {
  return `${value.toFixed(2)} dBTP`;
}

/** A lower number is worse when it is below `floor - tolerance`. */
function lowerIsBetter(subject: number, floor: number, tolerance: number): FloorAxisStanding {
  if (!Number.isFinite(subject)) return "worse";
  if (subject > floor + tolerance) return "worse";
  if (Number.isFinite(floor) && subject < floor - tolerance) return "better";
  return "equal";
}

/** A higher number is worse when it is above `floor + tolerance`. */
function higherIsWorse(subject: number, floor: number, tolerance: number): FloorAxisStanding {
  if (!Number.isFinite(subject)) return "worse";
  if (subject > floor + tolerance) return "worse";
  if (Number.isFinite(floor) && subject < floor - tolerance) return "better";
  return "equal";
}

function unmeasured(
  axis: FloorAxis,
  label: string,
  reason: string,
): FloorAxisReading {
  return {
    axis,
    label,
    direction: FLOOR_AXIS_DIRECTIONS[axis],
    standing: "unmeasured",
    subject: null,
    floor: null,
    detail: `${reason}, so ${axis} is not measured`,
  };
}

function levelAxis(input: AxisInput): FloorAxisReading {
  const label = "integrated loudness (LUFS)";
  if (!input.subjectLevel.measured) {
    return unmeasured("level", label, `the subject carries ${input.subjectLevel.reason}`);
  }
  if (!input.floorLevel.measured) {
    return unmeasured("level", label, `the floor carries ${input.floorLevel.reason}`);
  }
  const subject = input.subjectLevel.value.integratedLufs;
  const floor = input.floorLevel.value.integratedLufs;
  const deviation = Math.abs(subject - floor);
  const tolerance = FLOOR_AXIS_THRESHOLDS.levelDeviationLu;
  const standing: FloorAxisStanding = deviation > tolerance ? "worse" : "equal";
  const direction = subject > floor ? "louder" : "quieter";
  return {
    axis: "level",
    label,
    direction: FLOOR_AXIS_DIRECTIONS.level,
    standing,
    subject,
    floor,
    detail:
      `subject ${lufs(subject)} is ${deviation.toFixed(2)} LU from the floor's ${lufs(floor)}` +
      (standing === "worse"
        ? `, ${direction} and beyond the ${tolerance.toFixed(2)} LU target`
        : `, within the ${tolerance.toFixed(2)} LU target`),
  };
}

function peakAxis(input: AxisInput): FloorAxisReading {
  const label = "true-peak headroom (dB)";
  if (!input.subjectLevel.measured) {
    return unmeasured("peak", label, `the subject carries ${input.subjectLevel.reason}`);
  }
  if (!input.floorLevel.measured) {
    return unmeasured("peak", label, `the floor carries ${input.floorLevel.reason}`);
  }
  const subjectPeak = input.subjectLevel.value.truePeakDbtp;
  const floorPeak = input.floorLevel.value.truePeakDbtp;
  const subjectHeadroom = -subjectPeak;
  const floorHeadroom = -floorPeak;
  const tolerance = FLOOR_AXIS_THRESHOLDS.peakHeadroomDb;
  const standing = lowerIsBetter(subjectPeak, floorPeak, tolerance);
  const difference = floorHeadroom - subjectHeadroom;
  return {
    axis: "peak",
    label,
    direction: FLOOR_AXIS_DIRECTIONS.peak,
    standing,
    subject: subjectHeadroom,
    floor: floorHeadroom,
    detail:
      `subject true peak ${dbtp(subjectPeak)} leaves ${subjectHeadroom.toFixed(2)} dB of headroom against the floor's ` +
      `${dbtp(floorPeak)} (${floorHeadroom.toFixed(2)} dB)` +
      (standing === "worse"
        ? `, ${difference.toFixed(2)} dB less than the floor's`
        : standing === "better"
          ? `, ${(-difference).toFixed(2)} dB more than the floor's`
          : `, within the ${tolerance.toFixed(2)} dB tolerance`),
  };
}

function distortionAxis(input: AxisInput): FloorAxisReading {
  const label = "distortion residual vs reference (dB)";
  let subjectResidual: number;
  try {
    subjectResidual = distortionResidual(input.subject.reference.audio, input.subject.delivered.audio)
      .residualDb;
  } catch (error) {
    if (error instanceof DistortionCrestError) {
      return unmeasured(
        "distortion",
        label,
        `the subject's format cannot be residual-compared with its reference (${error.message})`,
      );
    }
    throw error;
  }

  // The floor is measured against the same reference, so the two residuals are
  // one scale. A floor that renders inside the clean-file bar has no residual
  // of its own to clear, so the published clean-file bar is the bar.
  let floorResidual = -Infinity;
  try {
    floorResidual = distortionResidual(input.subject.reference.audio, input.floor.audio).residualDb;
  } catch (error) {
    if (error instanceof DistortionCrestError) {
      return unmeasured(
        "distortion",
        label,
        `the floor cannot be residual-compared with the subject's reference (${error.message})`,
      );
    }
    throw error;
  }
  const cleanBar = FLOOR_AXIS_THRESHOLDS.distortionResidualDb;
  const bar = Math.max(floorResidual, cleanBar);
  // -Infinity is an exact copy, not the worst reading, so it cannot go through
  // the arithmetic comparison. A subject clearing the bar while the floor does
  // too is `equal`: the bar is the clean line, not a contest of infinitesimals.
  // A subject beats the floor only when the floor itself is above the bar.
  const standing: FloorAxisStanding =
    subjectResidual === Infinity || subjectResidual > bar
      ? "worse"
      : floorResidual > cleanBar && subjectResidual < floorResidual
        ? "better"
        : "equal";
  return {
    axis: "distortion",
    label,
    direction: FLOOR_AXIS_DIRECTIONS.distortion,
    standing,
    subject: subjectResidual,
    floor: floorResidual,
    detail:
      `subject residual ${db(subjectResidual)} against its reference; the floor renders ${db(floorResidual)} against ` +
      `the same reference, so the bar is ${db(bar)}` +
      (standing === "worse" ? " and a larger residual is worse" : " and the subject does not exceed it"),
  };
}

function breakupsAxis(input: AxisInput): FloorAxisReading {
  const label = "inserted silence (count / s / s)";
  const subject = measuredBreakups(input.subject.delivered.audio);
  if (subject === null) return unmeasured("breakups", label, "the subject's breakups cannot be measured");
  const floor = measuredBreakups(input.floor.audio);
  if (floor === null) return unmeasured("breakups", label, "the floor's breakups cannot be measured");

  const tolerance = FLOOR_AXIS_THRESHOLDS.breakupSeconds;
  const worse =
    subject.count > floor.count ||
    subject.totalSeconds > floor.totalSeconds + tolerance ||
    subject.longestSeconds > floor.longestSeconds + tolerance;
  const better =
    !worse &&
    (subject.count < floor.count ||
      subject.totalSeconds < floor.totalSeconds - tolerance ||
      subject.longestSeconds < floor.longestSeconds - tolerance);
  const standing: FloorAxisStanding = worse ? "worse" : better ? "better" : "equal";
  const describe = (report: BreakupReport) =>
    `${report.count} breakup${report.count === 1 ? "" : "s"}, ${report.totalSeconds.toFixed(3)} s total, ` +
    `${report.longestSeconds.toFixed(3)} s longest`;
  return {
    axis: "breakups",
    label,
    direction: FLOOR_AXIS_DIRECTIONS.breakups,
    standing,
    subject: subject.totalSeconds,
    floor: floor.totalSeconds,
    detail:
      `subject ${describe(subject)}; the floor has ${describe(floor)}` +
      (standing === "worse"
        ? `, more inserted silence than the ${tolerance.toFixed(3)} s tolerance allows`
        : ""),
  };
}

function modulationAxis(input: AxisInput): FloorAxisReading {
  const label = "envelope modulation depth (%)";
  const subject = measuredModulation(input.subject.delivered.audio);
  if (subject === null) return unmeasured("modulation", label, "the subject's envelope cannot be measured");
  const floor = measuredModulation(input.floor.audio);
  if (floor === null) return unmeasured("modulation", label, "the floor's envelope cannot be measured");

  const tolerance = FLOOR_AXIS_THRESHOLDS.modulationDepth;
  const standing = higherIsWorse(subject.depth, floor.depth, tolerance);
  const percent = (depth: number) => `${(depth * 100).toFixed(1)}%`;
  return {
    axis: "modulation",
    label,
    direction: FLOOR_AXIS_DIRECTIONS.modulation,
    standing,
    subject: subject.depth,
    floor: floor.depth,
    detail:
      `subject ${percent(subject.depth)} at ${subject.rateHz.toFixed(1)} Hz; the floor is ${percent(floor.depth)} at ` +
      `${floor.rateHz.toFixed(1)} Hz` +
      (standing === "worse"
        ? `, ${((subject.depth - floor.depth) * 100).toFixed(1)} points deeper than the ${(tolerance * 100).toFixed(0)}-point tolerance`
        : ""),
  };
}

/** The floor as a reader-facing phrase: voice/Locale, path and capture day. */
export function describeFloor(floor: FloorComparison["floor"]): string {
  const named =
    floor.voice && floor.locale ? `${floor.voice}/${floor.locale} at ${floor.path}` : floor.path;
  return floor.capturedOn ? `${named} (captured ${floor.capturedOn})` : named;
}

function summarize(comparison: Pick<FloorComparison, "floor" | "axes" | "worse" | "unmeasured" | "verdict">): string {
  const citation = describeFloor(comparison.floor);
  const missing = comparison.unmeasured.map(
    (axis) => `not measured on ${axis.axis} (${axis.detail})`,
  );
  if (comparison.verdict === "fail") {
    const reasons = comparison.worse.map((axis) => `worse on ${axis.axis} — ${axis.detail}`);
    const alsoMissing = missing.length > 0 ? `; ${missing.join("; ")}` : "";
    return `subject FAILS against the vendor floor ${citation}: ${reasons.join("; ")}${alsoMissing}.`;
  }
  if (comparison.verdict === "inconclusive") {
    return (
      `subject is INCONCLUSIVE against the vendor floor ${citation}: no axis is worse, but it clears nothing ` +
      `it was not measured on — ${missing.join("; ")}.`
    );
  }
  const readings = comparison.axes
    .filter((axis) => axis.standing !== "unmeasured")
    .map((axis) =>
      axis.axis === "level" && axis.subject !== null
        ? `level ${axis.standing} at ${lufs(axis.subject)}`
        : `${axis.axis} ${axis.standing}`,
    )
    .join(", ");
  return `subject PASSES against the vendor floor ${citation}: every measured axis is at or better than the floor (${readings}).`;
}

/**
 * Judge one subject against the vendor floor.
 *
 * Pure over its inputs: the floor and the subject are decoded files. `fail` is
 * reserved for a subject that is worse on at least one axis; a subject that is
 * merely different (inside an axis tolerance, or on the better side of it)
 * passes; a subject with no unmeasured axes left unknown only passes when every
 * axis was measured.
 */
export function compareToFloor(input: {
  floor: FloorReference;
  subject: FloorSubject;
}): FloorComparison {
  const { floor, subject } = input;
  const axisInput: AxisInput = {
    floor,
    subject,
    floorLevel: measuredLevel(floor.audio),
    subjectLevel: measuredLevel(subject.delivered.audio),
  };

  const axes: FloorAxisReading[] = [
    levelAxis(axisInput),
    peakAxis(axisInput),
    distortionAxis(axisInput),
    breakupsAxis(axisInput),
    modulationAxis(axisInput),
  ];
  const worse = axes.filter((axis) => axis.standing === "worse");
  const unmeasuredAxes = axes.filter((axis) => axis.standing === "unmeasured");
  const verdict: FloorVerdict =
    worse.length > 0 ? "fail" : unmeasuredAxes.length > 0 ? "inconclusive" : "pass";

  const cited = {
    path: floor.path,
    voice: floor.provenance?.voice ?? null,
    locale: floor.provenance?.locale ?? null,
    line: floor.provenance?.line ?? null,
    capturedOn: floor.provenance?.capturedOn ?? null,
  };
  const comparison: FloorComparison = {
    floor: cited,
    subject: { path: subject.delivered.path, referencePath: subject.reference.path },
    axes,
    worse,
    unmeasured: unmeasuredAxes,
    verdict,
    summary: "",
  };
  comparison.summary = summarize(comparison);
  return comparison;
}

/** The verdict as a deterministic block: floor, subject, every axis, one verdict. */
export function formatFloorVerdict(comparison: FloorComparison): string {
  const { floor, subject } = comparison;
  const axisWidth = Math.max(...comparison.axes.map((axis) => axis.axis.length));
  const standingWidth = Math.max(...comparison.axes.map((axis) => axis.standing.length));
  const lines = [
    "Floor mode — the vendor floor is the bar, not the previous take",
    `  floor     ${describeFloor(floor)}`,
    ...(floor.line ? [`  line      "${floor.line}"`] : []),
    `  subject   ${subject.path}`,
    `  reference ${subject.referencePath}`,
    "",
  ];
  for (const axis of comparison.axes) {
    lines.push(`  ${axis.axis.padEnd(axisWidth)}  ${axis.standing.padEnd(standingWidth)}  ${axis.detail}`);
  }
  lines.push("", `  verdict   ${comparison.verdict.toUpperCase()} — ${comparison.summary}`);
  return lines.join("\n");
}
