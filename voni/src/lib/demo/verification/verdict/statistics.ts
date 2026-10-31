/**
 * The verdict engine's arithmetic: one pooled sample, one nearest-rank
 * percentile, one comparison. The two numbers it reuses are imported from
 * their owners — the scoreboard's `percentile` and the kill criterion's
 * `MIN_SAMPLES_FOR_P50` — so this module declares no arithmetic of its own
 * beyond the summary.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Statistics and the pass rule".
 */

import { MIN_SAMPLES_FOR_P50 } from "../../kill-criterion";
import { percentile } from "../../scoreboard";

export { MIN_SAMPLES_FOR_P50 };

/** The three ways a bar compares to a measured value. */
export const COMPARISONS = ["at-most", "at-least", "exact"] as const;

export type Comparison = (typeof COMPARISONS)[number];

/** The statistics an evaluator may bind a threshold key to. */
export const STATISTICS = ["p50", "p95", "max", "min", "each"] as const;

export type Statistic = (typeof STATISTICS)[number];

/**
 * Below this many pooled samples a median is not a median: the values are
 * judged against their tail instead. The floor is the scoreboard's existing
 * rule, imported so the verdict engine cannot drift from it.
 */
export const SMALL_SAMPLE_FLOOR = MIN_SAMPLES_FOR_P50;

/** One property's pooled numbers. `null` when nothing was measured. */
export type SampleSummary = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly min: number;
};

/** Fold raw samples into the numbers a bar can judge. */
export function summarizeSamples(values: readonly number[]): SampleSummary | null {
  if (values.length === 0) return null;
  const p50 = percentile([...values], 50);
  const p95 = percentile([...values], 95);
  if (p50 === null || p95 === null) return null;
  let max = values[0];
  let min = values[0];
  for (const value of values) {
    if (value > max) max = value;
    if (value < min) min = value;
  }
  return { count: values.length, p50, p95, max, min };
}

/** The value one binding statistic reads off a summary. */
export function statisticValue(summary: SampleSummary, statistic: Statistic): number {
  switch (statistic) {
    case "p50":
      return summary.p50;
    case "p95":
      return summary.p95;
    case "max":
      return summary.max;
    case "min":
      return summary.min;
    case "each":
      throw new Error('"each" judges every sample, not one aggregate');
  }
}

/** Judge one measured value against one bar. No tolerance is assumed. */
export function compareToBudget(
  observed: number,
  budget: number,
  comparison: Comparison,
): boolean {
  switch (comparison) {
    case "at-most":
      return observed <= budget;
    case "at-least":
      return observed >= budget;
    case "exact":
      return observed === budget;
  }
}

/** The spec's operator words for a detail line. */
export function comparisonSymbol(comparison: Comparison): string {
  return comparison === "at-most" ? "<=" : comparison === "at-least" ? ">=" : "==";
}
