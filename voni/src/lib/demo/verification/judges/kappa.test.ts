import test from "node:test";
import assert from "node:assert/strict";

import { JudgeError } from "./errors";
import { RATING_MAX, RATING_MIN, weightedKappa } from "./kappa";
import type { RatingPair } from "./kappa";

/**
 * Weighted kappa's arithmetic against known contingency tables. Every expected
 * value below is worked out by hand from the definition
 * `kappa = 1 - observed disagreement / chance disagreement` with linear
 * weights `|rating - gold|`, never re-derived with the code.
 *
 * Linear weights on the 1-5 scale are ordinal: a two-point miss is penalised
 * twice a one-point miss, which is what a 1-5 human-quality scale means.
 */

/** Expand a rating x gold counts table into pairs. Rows are the judge. */
function table(rows: readonly (readonly number[])[]): RatingPair[] {
  const pairs: RatingPair[] = [];
  rows.forEach((row, judgeIndex) => {
    row.forEach((count, goldIndex) => {
      for (let n = 0; n < count; n += 1) {
        pairs.push({ judge: judgeIndex + 1, gold: goldIndex + 1 });
      }
    });
  });
  return pairs;
}

test("the rating scale is the panel's 1-5, and no other", () => {
  assert.equal(RATING_MIN, 1);
  assert.equal(RATING_MAX, 5);
});

test("a known 2x2 table yields kappa 0.4", () => {
  // judge/gold: [[20, 5], [10, 15]], n = 50.
  // Po = 35/50 = 0.7. Margins are both 25/25 against 30/20, so
  // Pe = (25*30 + 25*20) / 50^2 = 0.5. kappa = (0.7 - 0.5) / (1 - 0.5) = 0.4.
  const result = weightedKappa(table([
    [20, 5],
    [10, 15],
  ]));

  assert.ok(result);
  assert.equal(result.count, 50);
  assert.equal(result.kappa, 0.4);
  assert.equal(result.observedDisagreement, 0.3, "15 of 50 pairs disagree");
  assert.equal(result.expectedDisagreement, 0.5, "chance disagrees 25 of 50");
});

test("a known 3x3 table yields linear weighted kappa 219/253", () => {
  // [[10,1,0],[1,10,1],[0,1,10]], n = 34.
  // Linear disagreement: 4 adjacent misses (weight 1) = 4; the corner cells are
  // empty. Expected: margins 11/12/11, so
  // (4*11*12 + 2*11*11*2) / 34 = 1012 / 34 = 29.764705...
  // kappa = 1 - 4 / (1012/34) = 219/253 = 0.8656126...
  const result = weightedKappa(table([
    [10, 1, 0],
    [1, 10, 1],
    [0, 1, 10],
  ]));

  assert.ok(result);
  assert.equal(result.count, 34);
  assert.equal(result.kappa, 219 / 253);
  assert.equal(result.kappa.toFixed(4), "0.8656");
});

test("a known 3x3 table below the bar yields kappa 11/21", () => {
  // [[2,1,0],[1,2,1],[0,1,2]], n = 10. Margins 3/4/3.
  // Expected = (4*3*4 + 2*3*3*2) / 10 = 84/10 = 8.4.
  // kappa = 1 - 4 / 8.4 = 11/21 = 0.5238095..., below the 0.65 bar.
  const result = weightedKappa(table([
    [2, 1, 0],
    [1, 2, 1],
    [0, 1, 2],
  ]));

  assert.ok(result);
  assert.equal(result.count, 10);
  assert.equal(result.kappa, 11 / 21);
  assert.ok(result.kappa < 0.65, "the worked example is genuinely below the bar");
});

test("perfect agreement is kappa 1, and one miss is less than 1", () => {
  const perfect = weightedKappa(table([
    [5, 0, 0],
    [0, 5, 0],
    [0, 0, 5],
  ]));
  assert.ok(perfect);
  assert.equal(perfect.kappa, 1);

  const near = weightedKappa(table([
    [4, 1, 0],
    [0, 5, 0],
    [0, 0, 5],
  ]));
  assert.ok(near);
  assert.ok(near.kappa < 1);
  assert.ok(near.kappa > 0.9);
});

test("ratings outside the 1-5 scale are refused by name", () => {
  assert.throws(
    () => weightedKappa([{ judge: 0, gold: 3 }]),
    (error: unknown) =>
      error instanceof JudgeError && error.code === "invalid-rating" && /judge rating 0/.test(error.message),
  );
  assert.throws(
    () => weightedKappa([{ judge: 3, gold: 6 }]),
    (error: unknown) =>
      error instanceof JudgeError && error.code === "invalid-rating" && /gold rating 6/.test(error.message),
  );
  assert.throws(
    () => weightedKappa([{ judge: 3.5, gold: 3 }]),
    (error: unknown) => error instanceof JudgeError && error.code === "invalid-rating",
  );
});

test("a sample with no chance disagreement has no kappa, never a pass", () => {
  assert.equal(weightedKappa([]), null, "no pairs");
  assert.equal(weightedKappa([{ judge: 4, gold: 4 }]), null, "one pair");
  assert.equal(
    weightedKappa([
      { judge: 4, gold: 4 },
      { judge: 4, gold: 4 },
      { judge: 4, gold: 4 },
    ]),
    null,
    "every rating in one category: chance disagreement is zero, so kappa is undefined",
  );
});
