import test from "node:test";
import assert from "node:assert/strict";

import { MIN_SAMPLES_FOR_P50 as KILL_CRITERION_MIN_SAMPLES_FOR_P50 } from "../../kill-criterion";
import { percentile as scoreboardPercentile } from "../../scoreboard";
import {
  MIN_SAMPLES_FOR_P50,
  compareToBudget,
  summarizeSamples,
} from "./statistics";

/**
 * The verdict engine's arithmetic. Every expected value below is a worked
 * example from `.scratch/demo-verification/spec.md` ("Statistics and the pass
 * rule"), never a re-derivation with the code's own helpers.
 */

test("percentiles use the scoreboard's nearest-rank math, not a second definition", () => {
  const values = [10, 20, 30, 40, 50];
  for (const p of [5, 50, 95, 100]) {
    assert.equal(
      percentileOf(values, p),
      scoreboardPercentile(values, p),
      `p${p} must agree with the frozen scoreboard percentile`,
    );
  }
  assert.equal(percentileOf(values, 50), 30);
  assert.equal(percentileOf(values, 95), 50);
});

test("the p50 sample floor is the scoreboard's, shared with the kill criterion", () => {
  assert.equal(MIN_SAMPLES_FOR_P50, 3);
  assert.equal(MIN_SAMPLES_FOR_P50, KILL_CRITERION_MIN_SAMPLES_FOR_P50);
});

test("a summary carries count, median, tail and extremes", () => {
  const summary = summarizeSamples([120, 80, 900, 400, 350]);
  assert.deepEqual(summary, {
    count: 5,
    p50: 350,
    p95: 900,
    max: 900,
    min: 80,
  });
  assert.equal(summarizeSamples([]), null, "an empty sample has no summary");
});

test("comparisons are the three the bars use, and no others are guessed", () => {
  assert.equal(compareToBudget(300, 350, "at-most"), true);
  assert.equal(compareToBudget(351, 350, "at-most"), false);
  assert.equal(compareToBudget(30, 30, "at-least"), true);
  assert.equal(compareToBudget(29.99, 30, "at-least"), false);
  assert.equal(compareToBudget(1, 1, "exact"), true);
  assert.equal(compareToBudget(0, 1, "exact"), false);
});

// The local helper exists only so the parity assertion above cannot call the
// same function twice by accident.
function percentileOf(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}
