/**
 * W5 parity proof (voice-parity ticket 74): the timbre gate's measured result.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * The gate used to read one number — the level leg — and a voice could pass on
 * loudness alone. Spec W5 asks for a measured result: level against the
 * *measured* reference, true peak, distortion residual, crest factor, spectral
 * balance and breakups, all read from the delivered capture and the reference
 * rendering of the same line. This module produces that result; the gate in
 * `scoreboard.ts` consumes it and never a machine-only claim.
 *
 * ── Doctrine ──────────────────────────────────────────────────────────────
 * - **A missing metric is unmeasured, never zero.** A file that cannot carry a
 *   metric names the reason; the overall result is `INFO`, never a PASS.
 * - **A metric that cannot fail on a worst case does not ship.** Every axis has
 *   a synthetic worst case in `timbre-measurement.test.ts`.
 * - **New thresholds, never edited ones.** Every bar is a budget record added
 *   for this gate (`timbreMeasured*`); the older scoreboard and comparison
 *   records are untouched.
 * - **Level is metered, not derived.** The level axis re-uses the W0 level leg
 *   (`compareLevels`, 0.2 LU), so a voice cannot pass by arithmetic.
 *
 * The module is pure: decoded audio in, measurements out. Decoding stays with
 * the caller (`decodeAudioFile`), so a saved capture can be re-analysed without
 * a browser, network or database.
 */
import { detectBreakups, type BreakupReport } from "../audio/breakups";
import { crestFactor, distortionResidual } from "../audio/distortion-crest";
import type { DecodedAudio } from "../audio/format-facts";
import {
  LEVEL_TOLERANCE_DB,
  analyseLevel,
  compareLevels,
  type LevelFacts,
} from "../audio/level-facts";
import { measureSpectralBalance } from "../audio/spectral-balance";
import { SCOREBOARD_BUDGETS } from "./scoreboard-budgets";

/** The six axes a measured timbre result must carry, in report order. */
export const MEASURED_TIMBRE_AXES = [
  "level",
  "truePeak",
  "distortion",
  "crest",
  "spectralBalance",
  "breakups",
] as const;

export type MeasuredTimbreAxis = (typeof MEASURED_TIMBRE_AXES)[number];

export type MeasuredTimbreAxisVerdict = "pass" | "fail" | "unmeasured";

/** What one axis measured and against which bar. */
export type MeasuredTimbreAxisResult = {
  axis: MeasuredTimbreAxis;
  verdict: MeasuredTimbreAxisVerdict;
  /** The measured value; null when the axis could not be measured. */
  value: number | null;
  /** The bar the value was judged against, in the axis's own unit. */
  bar: number;
  unit: "lu" | "dbtp" | "db" | "ratio" | "count";
  detail: string;
};

/**
 * The measured result's verdict: `PASS` only when all six axes measured and
 * passed, `FAIL` when a measured axis is outside its bar, and `INFO` when any
 * axis is unmeasured and none failed.
 */
export type MeasuredTimbreResult = {
  status: "PASS" | "FAIL" | "INFO";
  axes: MeasuredTimbreAxisResult[];
  /** Every axis that failed, by name (empty when none). */
  failures: MeasuredTimbreAxis[];
  /** Every axis that could not be measured, by name. */
  unmeasured: MeasuredTimbreAxis[];
  /**
   * Claims refused before any axis was measured (ADR 0009). A refusal is a
   * FAIL with no failed axis: the audio the claim rests on is not delivered
   * audio, so there was nothing to measure.
   */
  refusals: string[];
  referenceFile: string | null;
  deliveredFile: string | null;
  /** One sentence naming every axis, so the gate can quote it. */
  detail: string;
};

/** One saved capture: the file it came from and its decoded samples. */
export type MeasuredLevelFile = {
  /** The saved file the reading was taken from; printed in the gate detail. */
  path: string;
  /** The decoded samples. */
  audio: DecodedAudio;
};

/**
 * The two measured files the result compares: the reference rendering of the
 * same line in the same voice, and the audio the caller actually received.
 * Both come from the W0 comparison's own files (tickets 10 and 12). Either may
 * be absent: a missing side is unmeasured, never zero.
 */
export type MeasuredLevelInput = {
  reference: MeasuredLevelFile;
  delivered: MeasuredLevelFile;
};

/** What the gate passes in: either capture may be missing, and is then unmeasured. */
export type MeasuredTimbreInput = {
  reference?: MeasuredLevelFile | null;
  delivered?: MeasuredLevelFile | null;
};

/**
 * The level leg's verdict: measured agreement, a measured difference, or the
 * named absence of a measurement. There is no arithmetic path — a missing file
 * is `INFO`/unmeasured, never a PASS.
 */
export type MeasuredLevelCheck = {
  status: "PASS" | "INFO" | "FAIL";
  /** The measured delivered integrated loudness, null unless both files measured. */
  deliveredLufs: number | null;
  /** The measured reference integrated loudness, null unless both files measured. */
  referenceLufs: number | null;
  /** Delivered minus reference, in LU; null unless both sides measured. */
  deltaLu: number | null;
  /** The tolerance the two readings were judged against, in LU. */
  toleranceDb: number;
  referenceFile: string | null;
  deliveredFile: string | null;
  detail: string;
};

const TRUE_PEAK_CEILING_DBTP = SCOREBOARD_BUDGETS.timbreMeasuredTruePeakDbtp.value;
const DISTORTION_MAX_DB = SCOREBOARD_BUDGETS.timbreMeasuredDistortionDb.value;
const CREST_MIN = SCOREBOARD_BUDGETS.timbreMeasuredCrestMin.value;
const BAND_DELTA_MAX_DB = SCOREBOARD_BUDGETS.timbreMeasuredBandDeltaDb.value;
const BREAKUP_MAX = SCOREBOARD_BUDGETS.timbreMeasuredBreakupMax.value;

/** How close two breakups must start to be the same hole in both files. */
export const BREAKUP_MATCH_SECONDS = SCOREBOARD_BUDGETS.timbreMeasuredBreakupMatchSeconds.value;

function unmeasuredLevel(detail: string): MeasuredLevelCheck {
  return {
    status: "INFO",
    deliveredLufs: null,
    referenceLufs: null,
    deltaLu: null,
    toleranceDb: LEVEL_TOLERANCE_DB,
    referenceFile: null,
    deliveredFile: null,
    detail: `unmeasured level: ${detail}`,
  };
}

function measuredFileFacts(
  file: MeasuredLevelFile | null | undefined,
  role: "reference" | "delivered",
): { ok: true; facts: Extract<LevelFacts, { measured: true }> } | { ok: false; detail: string } {
  if (!file) return { ok: false, detail: `no ${role} capture file` };
  let facts: LevelFacts;
  try {
    facts = analyseLevel(file.audio);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `${role} file ${file.path} could not be measured (${reason})` };
  }
  if (!facts.measured) {
    return { ok: false, detail: `${role} file ${file.path} carries no level (${facts.absence})` };
  }
  return { ok: true, facts };
}

/**
 * The timbre level leg: two measured files, one comparison — the delivered
 * integrated loudness against the reference within the library's 0.2 LU
 * tolerance. There is no derived formula left to green a voice no file
 * measured.
 */
export function checkMeasuredLevel(
  input?: MeasuredLevelInput | null,
  toleranceDb: number = LEVEL_TOLERANCE_DB,
): MeasuredLevelCheck {
  if (!input) {
    return unmeasuredLevel(
      "no reference and delivered capture, so the level leg has no file to measure",
    );
  }
  const reference = measuredFileFacts(input.reference, "reference");
  if (!reference.ok) return unmeasuredLevel(reference.detail);
  const delivered = measuredFileFacts(input.delivered, "delivered");
  if (!delivered.ok) return unmeasuredLevel(delivered.detail);

  const comparison = compareLevels(reference.facts, delivered.facts, toleranceDb);
  if (comparison.status === "unmeasured" || comparison.deltaLu === null) {
    return unmeasuredLevel(comparison.detail);
  }
  const detail =
    `${comparison.detail} (reference ${input.reference.path}, ` +
    `delivered ${input.delivered.path})`;
  return {
    status: comparison.status === "agrees" ? "PASS" : "FAIL",
    deliveredLufs: delivered.facts.integratedLufs,
    referenceLufs: reference.facts.integratedLufs,
    deltaLu: comparison.deltaLu,
    toleranceDb,
    referenceFile: input.reference.path,
    deliveredFile: input.delivered.path,
    detail,
  };
}

function levelAxis(check: MeasuredLevelCheck): MeasuredTimbreAxisResult {
  if (check.status === "INFO") {
    return {
      axis: "level",
      verdict: "unmeasured",
      value: null,
      bar: check.toleranceDb,
      unit: "lu",
      detail: check.detail,
    };
  }
  return {
    axis: "level",
    verdict: check.status === "PASS" ? "pass" : "fail",
    value: check.deltaLu === null ? null : Math.abs(check.deltaLu),
    bar: check.toleranceDb,
    unit: "lu",
    detail: check.detail,
  };
}

function truePeakAxis(
  delivered: ReturnType<typeof measuredFileFacts>,
): MeasuredTimbreAxisResult {
  if (!delivered.ok) {
    return {
      axis: "truePeak",
      verdict: "unmeasured",
      value: null,
      bar: TRUE_PEAK_CEILING_DBTP,
      unit: "dbtp",
      detail: `unmeasured true peak: ${delivered.detail}`,
    };
  }
  const peak = delivered.facts.truePeakDbtp;
  return {
    axis: "truePeak",
    verdict: peak <= TRUE_PEAK_CEILING_DBTP ? "pass" : "fail",
    value: peak,
    bar: TRUE_PEAK_CEILING_DBTP,
    unit: "dbtp",
    detail:
      peak <= TRUE_PEAK_CEILING_DBTP
        ? `true peak ${peak.toFixed(2)} dBTP at or below the ${TRUE_PEAK_CEILING_DBTP.toFixed(1)} dBTP ceiling`
        : `true peak ${peak.toFixed(2)} dBTP is above the ${TRUE_PEAK_CEILING_DBTP.toFixed(1)} dBTP ceiling`,
  };
}

function distortionAxis(input: MeasuredLevelInput | null, deliveredOk: boolean): MeasuredTimbreAxisResult {
  if (!deliveredOk || !input) {
    return {
      axis: "distortion",
      verdict: "unmeasured",
      value: null,
      bar: DISTORTION_MAX_DB,
      unit: "db",
      detail: "unmeasured distortion: no delivered capture file",
    };
  }
  try {
    const residual = distortionResidual(input.reference.audio, input.delivered.audio);
    const db = residual.residualDb;
    return {
      axis: "distortion",
      verdict: db <= DISTORTION_MAX_DB ? "pass" : "fail",
      value: db,
      bar: DISTORTION_MAX_DB,
      unit: "db",
      detail:
        db <= DISTORTION_MAX_DB
          ? `distortion residual ${formatDb(db)} dB at or below the ${DISTORTION_MAX_DB} dB bar`
          : `distortion residual ${formatDb(db)} dB is above the ${DISTORTION_MAX_DB} dB bar`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      axis: "distortion",
      verdict: "unmeasured",
      value: null,
      bar: DISTORTION_MAX_DB,
      unit: "db",
      detail: `unmeasured distortion: ${reason}`,
    };
  }
}

function formatDb(db: number): string {
  return Number.isFinite(db) ? db.toFixed(2) : "-inf";
}

function crestAxis(input: MeasuredLevelInput | null, deliveredOk: boolean): MeasuredTimbreAxisResult {
  if (!deliveredOk || !input) {
    return {
      axis: "crest",
      verdict: "unmeasured",
      value: null,
      bar: CREST_MIN,
      unit: "ratio",
      detail: "unmeasured crest factor: no delivered capture file",
    };
  }
  try {
    const crest = crestFactor(input.delivered.audio);
    return {
      axis: "crest",
      verdict: crest.crestFactor >= CREST_MIN ? "pass" : "fail",
      value: crest.crestFactor,
      bar: CREST_MIN,
      unit: "ratio",
      detail:
        crest.crestFactor >= CREST_MIN
          ? `crest factor ${crest.crestFactor.toFixed(2)} at or above the ${CREST_MIN} clean-voiced floor`
          : `crest factor ${crest.crestFactor.toFixed(2)} is below the ${CREST_MIN} clean-voiced floor (a squared-off signal)`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      axis: "crest",
      verdict: "unmeasured",
      value: null,
      bar: CREST_MIN,
      unit: "ratio",
      detail: `unmeasured crest factor: ${reason}`,
    };
  }
}

/**
 * The largest per-band move between the two captures after each is normalised
 * by its own mean band level, so a pure level change is the level axis's
 * business and not mistaken for a spectral tilt.
 */
function spectralAxis(input: MeasuredLevelInput | null, deliveredOk: boolean): MeasuredTimbreAxisResult {
  if (!deliveredOk || !input) {
    return {
      axis: "spectralBalance",
      verdict: "unmeasured",
      value: null,
      bar: BAND_DELTA_MAX_DB,
      unit: "db",
      detail: "unmeasured spectral balance: no delivered capture file",
    };
  }
  try {
    const reference = measureSpectralBalance(input.reference.audio);
    const delivered = measureSpectralBalance(input.delivered.audio);
    if (reference.silent || delivered.silent) {
      return {
        axis: "spectralBalance",
        verdict: "unmeasured",
        value: null,
        bar: BAND_DELTA_MAX_DB,
        unit: "db",
        detail: `unmeasured spectral balance: ${reference.silent ? "the reference" : "the delivered file"} carries no measurable energy`,
      };
    }
    const deliveredBands = new Map(delivered.bands.map((band) => [band.centreHz, band.levelDb]));
    const shared = reference.bands.filter((band) => deliveredBands.has(band.centreHz));
    if (shared.length === 0) {
      return {
        axis: "spectralBalance",
        verdict: "unmeasured",
        value: null,
        bar: BAND_DELTA_MAX_DB,
        unit: "db",
        detail: "unmeasured spectral balance: the two captures share no octave band",
      };
    }
    const mean = (bands: { levelDb: number }[]) =>
      bands.reduce((sum, band) => sum + band.levelDb, 0) / bands.length;
    const referenceMean = mean(shared);
    const deliveredShared = shared.map((band) => ({
      centreHz: band.centreHz,
      levelDb: deliveredBands.get(band.centreHz)!,
    }));
    const deliveredMean = mean(deliveredShared);
    let worst = 0;
    let worstCentre = shared[0].centreHz;
    for (const band of shared) {
      const delta =
        (deliveredBands.get(band.centreHz)! - deliveredMean) - (band.levelDb - referenceMean);
      if (Math.abs(delta) > Math.abs(worst)) {
        worst = delta;
        worstCentre = band.centreHz;
      }
    }
    const value = Number(Math.abs(worst).toFixed(2));
    return {
      axis: "spectralBalance",
      verdict: value <= BAND_DELTA_MAX_DB ? "pass" : "fail",
      value,
      bar: BAND_DELTA_MAX_DB,
      unit: "db",
      detail:
        value <= BAND_DELTA_MAX_DB
          ? `spectral balance within ${value.toFixed(2)} dB per band (worst ${worstCentre} Hz) at or below the ${BAND_DELTA_MAX_DB} dB bar`
          : `spectral balance moved ${value.toFixed(2)} dB in the ${worstCentre} Hz band, above the ${BAND_DELTA_MAX_DB} dB bar`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      axis: "spectralBalance",
      verdict: "unmeasured",
      value: null,
      bar: BAND_DELTA_MAX_DB,
      unit: "db",
      detail: `unmeasured spectral balance: ${reason}`,
    };
  }
}

/** A hole the delivered capture has that the reference does not. */
function unmatchedBreakups(delivered: BreakupReport, reference: BreakupReport): BreakupReport {
  const breakups = delivered.breakups.filter(
    (hole) =>
      !reference.breakups.some(
        (source) => Math.abs(source.startSeconds - hole.startSeconds) <= BREAKUP_MATCH_SECONDS,
      ),
  );
  return {
    breakups,
    count: breakups.length,
    totalSeconds: Number(breakups.reduce((sum, hole) => sum + hole.durationSeconds, 0).toFixed(3)),
    longestSeconds: Number(
      breakups.reduce((longest, hole) => Math.max(longest, hole.durationSeconds), 0).toFixed(3),
    ),
  };
}

function breakupAxis(input: MeasuredLevelInput | null, deliveredOk: boolean): MeasuredTimbreAxisResult {
  if (!deliveredOk || !input) {
    return {
      axis: "breakups",
      verdict: "unmeasured",
      value: null,
      bar: BREAKUP_MAX,
      unit: "count",
      detail: "unmeasured breakups: no delivered capture file",
    };
  }
  try {
    const holes = unmatchedBreakups(
      detectBreakups(input.delivered.audio),
      detectBreakups(input.reference.audio),
    );
    return {
      axis: "breakups",
      verdict: holes.count <= BREAKUP_MAX ? "pass" : "fail",
      value: holes.count,
      bar: BREAKUP_MAX,
      unit: "count",
      detail:
        holes.count <= BREAKUP_MAX
          ? `${holes.count} breakup${holes.count === 1 ? "" : "s"} at or below the ${BREAKUP_MAX} bar (total ${holes.totalSeconds.toFixed(2)}s, longest ${holes.longestSeconds.toFixed(2)}s)`
          : `${holes.count} inserted silences above the ${BREAKUP_MAX} bar (total ${holes.totalSeconds.toFixed(2)}s, longest ${holes.longestSeconds.toFixed(2)}s)`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      axis: "breakups",
      verdict: "unmeasured",
      value: null,
      bar: BREAKUP_MAX,
      unit: "count",
      detail: `unmeasured breakups: ${reason}`,
    };
  }
}

function summarize(axes: MeasuredTimbreAxisResult[]): string {
  return axes.map((axis) => `${axis.axis}: ${axis.detail}`).join("; ");
}

/** Two decoded files carrying the same samples in the same format. */
function sameAudio(left: DecodedAudio, right: DecodedAudio): boolean {
  if (
    left.facts.sampleRate !== right.facts.sampleRate ||
    left.facts.channels !== right.facts.channels ||
    left.facts.frameCount !== right.facts.frameCount ||
    left.samples.length !== right.samples.length
  ) {
    return false;
  }
  for (let index = 0; index < left.samples.length; index += 1) {
    if (left.samples[index] !== right.samples[index]) return false;
  }
  return true;
}

/**
 * The delivery the claim rests on, or null when it is real (ADR 0009).
 *
 * A gate ready to PASS needs audio the caller actually received. A reference
 * render passed in a second time — under the same path or as a copy — compares
 * a file with itself, agrees on every axis and would green a delivery that
 * never happened. There is no measurement that can detect this, so the claim is
 * refused by name before any axis is read.
 */
function undeliveredClaim(input: MeasuredTimbreInput): string | null {
  const reference = input.reference ?? null;
  const delivered = input.delivered ?? null;
  if (reference === null || delivered === null) return null;
  if (reference.path === delivered.path) {
    return (
      `the delivered "capture" is the reference render (${reference.path}); ` +
      "a timbre claim without delivered audio is invalid (ADR 0009)"
    );
  }
  if (sameAudio(reference.audio, delivered.audio)) {
    return (
      `the delivered capture is identical to the reference render (${delivered.path} carries ` +
      `${reference.path}'s samples); a copy is not a delivery, and a timbre claim without ` +
      "delivered audio is invalid (ADR 0009)"
    );
  }
  return null;
}

/** One refusal, shaped like an unmeasured pass attempt: nothing was measured. */
function refused(result: {
  refusals: string[];
  referenceFile: string | null;
  deliveredFile: string | null;
}): MeasuredTimbreResult {
  const axes = MEASURED_TIMBRE_AXES.map(
    (axis): MeasuredTimbreAxisResult => ({
      axis,
      verdict: "unmeasured",
      value: null,
      bar: 0,
      unit: "count",
      detail: `unmeasured ${axis}: the claim was refused before measurement`,
    }),
  );
  return {
    status: "FAIL",
    axes,
    failures: [],
    unmeasured: [...MEASURED_TIMBRE_AXES],
    refusals: [...result.refusals],
    referenceFile: result.referenceFile,
    deliveredFile: result.deliveredFile,
    detail: `measured timbre FAIL — refused: ${result.refusals.join("; ")}`,
  };
}

/**
 * Measure the six timbre axes from the reference and delivered captures. The
 * verdict is `PASS` only when every axis measured and passed; a missing axis
 * is `INFO`, and a measured miss is `FAIL` with the axis named.
 */
export function measureTimbre(input?: MeasuredTimbreInput | null): MeasuredTimbreResult {
  if (input) {
    const refusal = undeliveredClaim(input);
    if (refusal !== null) {
      return refused({
        refusals: [refusal],
        referenceFile: input.reference?.path ?? null,
        deliveredFile: input.delivered?.path ?? null,
      });
    }
  }
  if (!input) {
    const axes = MEASURED_TIMBRE_AXES.map(
      (axis): MeasuredTimbreAxisResult => ({
        axis,
        verdict: "unmeasured",
        value: null,
        bar: 0,
        unit: "count",
        detail: `unmeasured ${axis}: no reference and delivered capture`,
      }),
    );
    return {
      status: "INFO",
      axes,
      failures: [],
      unmeasured: [...MEASURED_TIMBRE_AXES],
      refusals: [],
      referenceFile: null,
      deliveredFile: null,
      detail: `unmeasured timbre: ${summarize(axes)}`,
    };
  }

  const reference = input.reference ?? null;
  const deliveredFile = input.delivered ?? null;
  const full: MeasuredLevelInput | null =
    reference && deliveredFile ? { reference, delivered: deliveredFile } : null;
  const level = full
    ? checkMeasuredLevel(full)
    : unmeasuredLevel(!reference ? "no reference capture file" : "no delivered capture file");
  const delivered = measuredFileFacts(deliveredFile, "delivered");
  const deliveredOk = delivered.ok && full !== null;
  const axes: MeasuredTimbreAxisResult[] = [
    levelAxis(level),
    truePeakAxis(delivered),
    distortionAxis(full, deliveredOk),
    crestAxis(full, deliveredOk),
    spectralAxis(full, deliveredOk),
    breakupAxis(full, deliveredOk),
  ];
  const failures = axes.filter((axis) => axis.verdict === "fail").map((axis) => axis.axis);
  const unmeasured = axes
    .filter((axis) => axis.verdict === "unmeasured")
    .map((axis) => axis.axis);
  const status = failures.length > 0 ? "FAIL" : unmeasured.length > 0 ? "INFO" : "PASS";
  const lead =
    status === "PASS"
      ? "measured timbre PASS"
      : status === "FAIL"
        ? `measured timbre FAIL (${failures.join(", ")})`
        : `measured timbre unmeasured (${unmeasured.join(", ")})`;
  return {
    status,
    axes,
    failures,
    unmeasured,
    refusals: [],
    referenceFile: reference?.path ?? null,
    deliveredFile: deliveredFile?.path ?? null,
    detail: `${lead} — ${summarize(axes)}`,
  };
}
