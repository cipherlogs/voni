import test from "node:test";
import assert from "node:assert/strict";

/**
 * Ticket 07 store contract: ratings persist as append-only records keyed by
 * call id and turn id, carrying the filler line, the split, the verdict, the
 * tag and the note — replayable as a repro beside marks + delivered capture.
 */
import {
  REVIEW_RATING_SCHEMA_VERSION,
  REVIEW_TAGS,
  createReviewRatings,
  recordStartRating,
  recordTurnRating,
  type LatencySplitSummary,
} from "./review-ratings";

const SPLIT: LatencySplitSummary = {
  endpointingMs: 120,
  generationMs: 800,
  deliveryMs: 90,
  perceivedMs: 1060,
};

test("turn ratings are append-only and keyed by call and turn", () => {
  const store = createReviewRatings();
  recordTurnRating(store, {
    callId: "call-1",
    turnId: "turn-1",
    verdict: "bad",
    tag: "robotic",
    note: "Mm felt wrong",
    fillerLine: "Mm.",
    split: SPLIT,
  });
  recordTurnRating(store, {
    callId: "call-1",
    turnId: "turn-2",
    verdict: "good",
    tag: "good-cover",
    fillerLine: null,
    split: SPLIT,
  });
  const all = store.listTurnRatings("call-1");
  assert.equal(all.length, 2);
  assert.equal(all[0]?.turnId, "turn-1");
  assert.equal(all[1]?.turnId, "turn-2");
  assert.equal(all[0]?.fillerLine, "Mm.");
  assert.deepEqual(all[0]?.split, SPLIT);
  assert.equal(all[0]?.verdict, "bad");
  assert.equal(all[0]?.tag, "robotic");
});

test("a turn rating is write-once: a second rating for the same turn is refused", () => {
  const store = createReviewRatings();
  recordTurnRating(store, {
    callId: "call-1",
    turnId: "turn-1",
    verdict: "good",
    tag: "good-cover",
    fillerLine: null,
    split: null,
  });
  assert.throws(
    () =>
      recordTurnRating(store, {
        callId: "call-1",
        turnId: "turn-1",
        verdict: "bad",
        tag: "late",
        fillerLine: null,
        split: null,
      }),
    /write-once/,
  );
  assert.equal(store.listTurnRatings("call-1").length, 1);
});

test("the filler tag vocabulary names the failure", () => {
  assert.deepEqual([...REVIEW_TAGS], [
    "out-of-context",
    "robotic",
    "late",
    "missing",
    "early-cut",
    "good-cover",
    "silent-better",
  ]);
  const store = createReviewRatings();
  assert.throws(
    () =>
      recordTurnRating(store, {
        callId: "call-1",
        turnId: "turn-9",
        verdict: "bad",
        // @ts-expect-error — an invented tag is not a rating
        tag: "meh",
        fillerLine: null,
        split: null,
      }),
    /tag/,
  );
});

test("one start rating per call covers the wait and the chime", () => {
  const store = createReviewRatings();
  recordStartRating(store, { callId: "call-1", verdict: "good", note: "chime on first audio" });
  assert.equal(store.getStartRating("call-1")?.verdict, "good");
  assert.throws(
    () => recordStartRating(store, { callId: "call-1", verdict: "bad", note: "late" }),
    /write-once/,
  );
});

test("ratings serialize beside marks and delivered capture for replay", () => {
  const store = createReviewRatings();
  recordStartRating(store, { callId: "call-1", verdict: "bad", note: "silent start" });
  recordTurnRating(store, {
    callId: "call-1",
    turnId: "turn-1",
    verdict: "bad",
    tag: "missing",
    note: "no cover before a slow reply",
    fillerLine: null,
    split: SPLIT,
  });
  const artifact = store.toArtifact("call-1");
  assert.equal(artifact.schemaVersion, REVIEW_RATING_SCHEMA_VERSION);
  assert.equal(artifact.callId, "call-1");
  assert.equal(artifact.start?.verdict, "bad");
  assert.equal(artifact.turns.length, 1);
  assert.equal(artifact.turns[0]?.tag, "missing");
  // Replay: a later fix reads the unaddressed bad records as its repro.
  const bad = store.unaddressedBadTurns("call-1");
  assert.equal(bad.length, 1);
  assert.equal(bad[0]?.turnId, "turn-1");
});

test("empty call or turn ids are refused by name", () => {
  const store = createReviewRatings();
  assert.throws(
    () =>
      recordTurnRating(store, {
        callId: "  ",
        turnId: "turn-1",
        verdict: "good",
        tag: "good-cover",
        fillerLine: null,
        split: null,
      }),
    /callId/,
  );
  assert.throws(
    () => recordStartRating(store, { callId: "", verdict: "good" }),
    /callId/,
  );
});
