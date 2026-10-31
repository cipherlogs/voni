/**
 * Linear weighted kappa for the panel's ordinal 1-5 ratings.
 *
 * `kappa = 1 - observed disagreement / chance disagreement`, where a pair's
 * disagreement is `|judge - gold|`. The result is the usual linear weighted
 * kappa: a two-point miss counts twice a one-point miss. Unweighted kappa is the
 * special case of a two-category rating and is not a substitute here.
 *
 * No kappa is invented for an uninformative sample. Fewer than two pairs, or a
 * sample whose chance disagreement is zero (every rating in one category), has
 * no defined kappa and returns `null`; the calibration gate treats that as
 * unverified, never as perfect agreement.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging" and H6.
 */

import { JudgeError } from "./errors";

/** The panel's rating scale is 1-5 on every axis. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/** One pair: the judge's rating and the panel's gold label, both 1-5. */
export type RatingPair = {
  readonly judge: number;
  readonly gold: number;
};

export type KappaResult = {
  /** 1 is perfect agreement, 0 is chance, below 0 is worse than chance. */
  readonly kappa: number;
  readonly count: number;
  /** Mean rating-point disagreement per pair (0 on agreement, up to 4). */
  readonly observedDisagreement: number;
  /** Expected mean disagreement under independence, from the two marginals. */
  readonly expectedDisagreement: number;
};

function checkRating(value: number, field: "judge" | "gold"): void {
  if (!Number.isInteger(value) || value < RATING_MIN || value > RATING_MAX) {
    throw new JudgeError(
      "invalid-rating",
      `${field} rating ${String(value)} is not an integer on the ${RATING_MIN}-${RATING_MAX} ` +
        "panel scale",
    );
  }
}

/** Linear ordinal weight: 0 on agreement, the rating-point distance otherwise. */
export function linearWeight(left: number, right: number): number {
  return Math.abs(left - right);
}

/**
 * Compute kappa over one judge's ratings against gold labels. `null` means the
 * sample carries no defined kappa; it is never a pass.
 */
export function weightedKappa(pairs: readonly RatingPair[]): KappaResult | null {
  for (const pair of pairs) {
    checkRating(pair.judge, "judge");
    checkRating(pair.gold, "gold");
  }
  if (pairs.length < 2) return null;

  const size = RATING_MAX - RATING_MIN + 1;
  const observed = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const judgeCounts = Array<number>(size).fill(0);
  const goldCounts = Array<number>(size).fill(0);

  for (const pair of pairs) {
    const judgeIndex = pair.judge - RATING_MIN;
    const goldIndex = pair.gold - RATING_MIN;
    observed[judgeIndex][goldIndex] += 1;
    judgeCounts[judgeIndex] += 1;
    goldCounts[goldIndex] += 1;
  }

  const count = pairs.length;
  let observedWeight = 0;
  let expectedWeight = 0;
  for (let judgeIndex = 0; judgeIndex < size; judgeIndex += 1) {
    for (let goldIndex = 0; goldIndex < size; goldIndex += 1) {
      const weight = linearWeight(
        judgeIndex + RATING_MIN,
        goldIndex + RATING_MIN,
      );
      observedWeight += weight * observed[judgeIndex][goldIndex];
      expectedWeight +=
        (weight * judgeCounts[judgeIndex] * goldCounts[goldIndex]) / count;
    }
  }

  if (expectedWeight === 0) return null;

  return {
    kappa: 1 - observedWeight / expectedWeight,
    count,
    observedDisagreement: observedWeight / count,
    expectedDisagreement: expectedWeight / count,
  };
}
