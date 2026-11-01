/**
 * A refusal prints the adapter's cause, never a gap that happened to be first.
 *
 * Regression: the 2026-11-01 live fast run could not reach the pipeline, and
 * the CLI printed "the browser run's elapsed time was not measured … the budget
 * is unknown" — the first `unrun` line — instead of the pipeline-unreachable
 * cause. The same shape appears whenever a call produces INFO before its fault.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { adapterRefusalFor } from "./adapter-refusal";

const BUDGET_GAP =
  "the browser run's elapsed time was not measured against the declared 120000ms ceiling; " +
  "the budget is unknown (INFO, never within)";

test("the adapter's named cause wins over an INFO line that happens to be first", () => {
  const refusal = adapterRefusalFor({
    refused: true,
    refusal: {
      code: "pipeline-unreachable",
      message: "the certifying browser run cannot start; missing: pipeline-unreachable",
    },
    unrun: [BUDGET_GAP, "the certifying browser run cannot start"],
    fallback: "no reason",
  });
  assert.equal(refusal?.code, "pipeline-unreachable");
  assert.match(refusal?.message ?? "", /pipeline-unreachable/);
  assert.doesNotMatch(refusal?.message ?? "", /budget is unknown/);
});

test("an adapter that recorded no cause falls back to its first unrun line", () => {
  const refusal = adapterRefusalFor({
    refused: true,
    refusal: null,
    unrun: ["the vendor key is absent"],
    fallback: "no reason",
  });
  assert.equal(refusal?.code, "adapter-refused");
  assert.equal(refusal?.message, "the vendor key is absent");
});

test("a run that did not refuse maps to no refusal at all", () => {
  assert.equal(
    adapterRefusalFor({
      refused: false,
      refusal: { code: "late", message: "must not be reported" },
      unrun: [],
      fallback: "no reason",
    }),
    null,
  );
});

test("an adapter with neither cause nor unrun line still says something true", () => {
  const refusal = adapterRefusalFor({
    refused: true,
    refusal: null,
    unrun: [],
    fallback: "the browser adapter refused without a reason",
  });
  assert.equal(refusal?.message, "the browser adapter refused without a reason");
});
