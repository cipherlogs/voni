import test from "node:test";
import assert from "node:assert/strict";

import { reviewOverlayRequested } from "./review-ratings";
import { formatSplit } from "@/components/review-overlay";

test("the review overlay hides unless ?review=1", () => {
  assert.equal(reviewOverlayRequested(""), false);
  assert.equal(reviewOverlayRequested("?review=1"), true);
  assert.equal(reviewOverlayRequested("?review=0"), false);
  assert.equal(reviewOverlayRequested("?delivercapture=1"), false);
});

test("a turn without a sample reports no sample, never a zero", () => {
  assert.equal(formatSplit(null), "no sample");
  assert.match(
    formatSplit({ endpointingMs: 1, generationMs: 2, deliveryMs: 3, perceivedMs: 56 }),
    /endpointing 1ms/,
  );
});
