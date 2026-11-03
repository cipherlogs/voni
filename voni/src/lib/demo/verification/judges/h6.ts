/**
 * H6 — judge agreement with gold labels.
 *
 * The evaluator reads the judge evidence source (a rubric plus the panel's
 * calibration record), calibrates every judge against the gold labels and
 * returns each defined kappa as a sample. The verdict engine binds the frozen
 * `dvJudgeKappaMin` bar to every sample, so one below-bar judge fails H6. When
 * calibration is impossible the evaluator is `unmeasured` with the reason; the
 * engine turns that into a failure. H6 never returns a pass of its own.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging", H6.
 */

import type { PropertyEvaluator } from "../verdict/types";
import { calibrate } from "./calibration";
import { JudgeError } from "./errors";
import type { CalibrationRecord, JudgeEvidence, Rubric } from "./types";

function reasonOf(error: unknown): string {
  if (error instanceof JudgeError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Read the judge source without trusting its shape. */
function evidenceOf(source: unknown): JudgeEvidence {
  if (typeof source !== "object" || source === null) {
    throw new JudgeError(
      "missing-evidence",
      "the judge evidence source carries no rubric or calibration record",
    );
  }
  const record = source as Record<string, unknown>;
  if (typeof record.rubric !== "object" || record.rubric === null) {
    throw new JudgeError("missing-evidence", "the judge evidence carries no rubric");
  }
  if (typeof record.calibration !== "object" || record.calibration === null) {
    throw new JudgeError(
      "missing-evidence",
      "the judge evidence carries no panel calibration record",
    );
  }
  return {
    rubric: record.rubric as Rubric,
    calibration: record.calibration as CalibrationRecord,
  };
}

export const h6Evaluator: PropertyEvaluator = {
  propertyId: "H6",
  source: "judges/h6",
  bars: [{ key: "dvJudgeKappaMin", statistic: "each", comparison: "at-least" }],
  evaluate(context) {
    try {
      const evidence = evidenceOf(context.source);
      const verdict = calibrate({ rubric: evidence.rubric, record: evidence.calibration });
      if (verdict.status !== "verified") {
        return {
          kind: "unmeasured",
          reason: verdict.detail,
          citations: verdict.citations,
        };
      }
      return {
        kind: "measured",
        samples: verdict.kappas,
        citations: verdict.citations,
        detail: verdict.detail,
      };
    } catch (error) {
      return {
        kind: "unmeasured",
        reason: `judge calibration refused: ${reasonOf(error)}`,
        citations: [],
      };
    }
  },
};
