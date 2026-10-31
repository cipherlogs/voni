/**
 * Calibration: does this judge agree with the panel's gold labels well enough
 * to gate?
 *
 * Weighted kappa is computed per judge and per rubric axis against the owner's
 * gold labels. Only a panel whose every judge is at or above the frozen H6 bar
 * (0.65, from the budget record) is `verified`. A below-bar kappa, an
 * uninformative sample, a missing axis, a duplicate rating, a vendor collision
 * or a rubric hash that no longer matches the current rubric makes the verdict
 * `unverified` — which H6 reports as a failure, so the run cannot certify.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging", H6.
 */

import { SCOREBOARD_BUDGETS } from "../../scoreboard-budgets";
import { JudgeError } from "./errors";
import { RATING_MAX, RATING_MIN, weightedKappa } from "./kappa";
import { assertJudgeIndependence } from "./panel";
import { rubricHash } from "./rubric";
import type {
  AxisCalibration,
  CalibrationItem,
  CalibrationRecord,
  CalibrationVerdict,
  JudgeIdentity,
  Rubric,
} from "./types";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ratingProblem(value: unknown, label: string): string | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < RATING_MIN ||
    value > RATING_MAX
  ) {
    return `${label} ${String(value)} is not an integer on the ${RATING_MIN}-${RATING_MAX} scale`;
  }
  return null;
}

/** The judge ids in a record, refusing a duplicate or missing id. */
function judgeProblems(judges: readonly JudgeIdentity[]): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const judge of judges) {
    const id = text(judge?.id);
    if (id === "") {
      reasons.push("a calibration judge has no id");
      continue;
    }
    if (seen.has(id)) {
      reasons.push(`judge "${id}" is listed twice in the calibration record`);
      continue;
    }
    seen.add(id);
  }
  return reasons;
}

function validateItem(
  item: CalibrationItem,
  index: number,
  rubric: Rubric,
  knownJudges: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  if (!isObject(item)) {
    return [`calibration item ${index} is not a record`];
  }
  const callId = text(item.callId);
  if (callId === "") {
    reasons.push(`calibration item ${index} has no call id`);
  }
  const axis = text(item.axis);
  if (!rubric.axes.some((entry) => entry.id === axis)) {
    reasons.push(
      `calibration item ${index} scores axis "${axis}", which is not in rubric "${rubric.id}"`,
    );
  }
  const judgeId = text(item.judgeId);
  if (!knownJudges.has(judgeId)) {
    reasons.push(
      `calibration item ${index} names judge "${judgeId}", which is not a judged model of the panel`,
    );
  }
  const scoreProblem = ratingProblem(item.score, `judge "${judgeId}" score`);
  if (scoreProblem !== null) reasons.push(scoreProblem);
  const goldProblem = ratingProblem(item.gold, `gold label for "${callId}"`);
  if (goldProblem !== null) reasons.push(goldProblem);
  return reasons;
}

function unverified(
  base: {
    rubricHash: string;
    minKappa: number;
    axes: readonly AxisCalibration[];
    kappas: readonly number[];
    citations: readonly string[];
  },
  reasons: readonly string[],
): CalibrationVerdict {
  return {
    status: "unverified",
    ...base,
    reasons: [...new Set(reasons)],
    detail: `unverified: ${[...new Set(reasons)].join("; ")}`,
  };
}

/**
 * Calibrate the judges against the panel's gold labels. The rubric hash and the
 * budget bar are both required; neither can be supplied by the caller.
 */
export function calibrate(input: {
  rubric: Rubric;
  record: CalibrationRecord;
}): CalibrationVerdict {
  const minKappa = SCOREBOARD_BUDGETS.dvJudgeKappaMin.value;
  const hash = rubricHash(input.rubric);
  const citationsFor = (items: readonly CalibrationItem[]): string[] =>
    unique(
      (Array.isArray(items) ? items : [])
        .map((item) => text(item?.callId))
        .filter((callId) => callId !== "")
        .map((callId) => `panel:${callId}`),
    );

  if (!isObject(input.record)) {
    return unverified(
      { rubricHash: hash, minKappa, axes: [], kappas: [], citations: [] },
      ["the judge evidence carries no calibration record"],
    );
  }
  const record = input.record;
  const items: readonly CalibrationItem[] = Array.isArray(record.items) ? record.items : [];
  const citations = citationsFor(items);
  const base = { rubricHash: hash, minKappa, citations };

  const recordedHash = text(record.rubricHash);
  if (recordedHash !== hash) {
    return unverified(
      { ...base, axes: [], kappas: [] },
      [
        `rubric changed: the calibration was scored against "${recordedHash}", ` +
          `the current rubric is "${hash}"; recalibrate before the judge may gate`,
      ],
    );
  }

  const judges = Array.isArray(record.judges) ? record.judges : [];
  const reasons = judgeProblems(judges);
  if (judges.length < 2) {
    reasons.push(`calibration needs two judges; the record lists ${judges.length}`);
  }
  try {
    assertJudgeIndependence(judges);
  } catch (error) {
    if (error instanceof JudgeError) reasons.push(error.message);
    else reasons.push(String(error));
  }

  const knownJudges = new Set(judges.map((judge) => text(judge?.id)));
  const seen = new Set<string>();
  const grouped = new Map<string, CalibrationItem[]>();
  items.forEach((item, index) => {
    const itemReasons = validateItem(item, index, input.rubric, knownJudges);
    reasons.push(...itemReasons);
    if (itemReasons.length > 0) return;
    const key = `${text(item.judgeId)}#${text(item.axis)}#${text(item.callId)}`;
    if (seen.has(key)) {
      reasons.push(
        `judge "${item.judgeId}" rated call "${item.callId}" on axis "${item.axis}" twice`,
      );
      return;
    }
    seen.add(key);
    const groupKey = `${text(item.judgeId)}#${text(item.axis)}`;
    const group = grouped.get(groupKey) ?? [];
    group.push(item);
    grouped.set(groupKey, group);
  });

  const axes: AxisCalibration[] = [];
  const kappas: number[] = [];
  for (const judge of judges) {
    const judgeId = text(judge?.id);
    if (judgeId === "") continue;
    for (const axis of input.rubric.axes) {
      const pairs = (grouped.get(`${judgeId}#${axis.id}`) ?? []).map((item) => ({
        judge: item.score,
        gold: item.gold,
      }));
      if (pairs.length === 0) {
        axes.push({
          judgeId,
          axis: axis.id,
          kappa: null,
          count: 0,
          belowBar: true,
          reason: "no gold labels for this judge on this axis",
        });
        reasons.push(
          `judge "${judgeId}" has no gold-label pairs on axis "${axis.id}"; ` +
            "the axis cannot be calibrated",
        );
        continue;
      }
      let result: ReturnType<typeof weightedKappa>;
      try {
        result = weightedKappa(pairs);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        axes.push({
          judgeId,
          axis: axis.id,
          kappa: null,
          count: pairs.length,
          belowBar: true,
          reason,
        });
        reasons.push(`judge "${judgeId}" axis "${axis.id}": ${reason}`);
        continue;
      }
      if (result === null) {
        const reason =
          `no defined kappa (${pairs.length} pair${pairs.length === 1 ? "" : "s"}; ` +
          "chance disagreement is zero or the sample is too small)";
        axes.push({
          judgeId,
          axis: axis.id,
          kappa: null,
          count: pairs.length,
          belowBar: true,
          reason,
        });
        reasons.push(`judge "${judgeId}" axis "${axis.id}": ${reason}`);
        continue;
      }
      const belowBar = result.kappa < minKappa;
      axes.push({
        judgeId,
        axis: axis.id,
        kappa: result.kappa,
        count: result.count,
        belowBar,
      });
      kappas.push(result.kappa);
      if (belowBar) {
        reasons.push(
          `judge "${judgeId}" axis "${axis.id}" weighted kappa ` +
            `${result.kappa.toFixed(4)} < ${minKappa} bar`,
        );
      }
    }
  }

  if (reasons.length > 0) {
    return unverified({ ...base, axes, kappas }, reasons);
  }
  const detail =
    `verified: ${judges.length} judges and ${input.rubric.axes.length} axes at ` +
    `weighted kappa >= ${minKappa} against panel gold labels (rubric ${hash.slice(0, 12)})`;
  return {
    status: "verified",
    rubricHash: hash,
    minKappa,
    axes,
    kappas,
    reasons: [],
    citations,
    detail,
  };
}
