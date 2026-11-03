import test from "node:test";
import assert from "node:assert/strict";

/**
 * Ticket 08 store contract: the owner marks each fix fixed or not-fixed with
 * the still-broken feeling named, so a retry changes behaviour instead of
 * repeating it and no new work starts on a broken feeling.
 */
import {
  FIX_GATE_SCHEMA_VERSION,
  canSaveFixGate,
  createFixGate,
  fixUnderReview,
} from "./fix-gate";
import { createReviewRatings } from "./review-ratings";

test("a fixed fix advances; an unrated fix does not advance", () => {
  const gate = createFixGate();
  assert.equal(gate.canAdvance("08"), false);
  gate.recordFix({ fixId: "08", verdict: "fixed", callId: "call-1" });
  assert.equal(gate.canAdvance("08"), true);
  assert.equal(gate.blocksNext("08"), false);
});

test("a not-fixed fix stays open, names the still-broken feeling, and blocks the next fix", () => {
  const gate = createFixGate();
  gate.recordFix({
    fixId: "08",
    verdict: "not-fixed",
    stillBroken: "the cover still says Mm on Hi",
    callId: "call-1",
  });
  const record = gate.getFix("08");
  assert.equal(record?.verdict, "not-fixed");
  assert.equal(record?.stillBroken, "the cover still says Mm on Hi");
  assert.equal(gate.canAdvance("08"), false);
  assert.equal(gate.blocksNext("08"), true);
});

test("not-fixed without the still-broken feeling is refused", () => {
  const gate = createFixGate();
  assert.throws(
    () => gate.recordFix({ fixId: "08", verdict: "not-fixed", stillBroken: "  " }),
    /still-broken/,
  );
  assert.equal(gate.getFix("08"), null);
  assert.equal(gate.canAdvance("08"), false);
});

test("a fix verdict is write-once: a second mark for the same fix is refused", () => {
  const gate = createFixGate();
  gate.recordFix({ fixId: "08", verdict: "fixed", callId: "call-1" });
  assert.throws(
    () => gate.recordFix({ fixId: "08", verdict: "not-fixed", stillBroken: "late" }),
    /write-once/,
  );
  assert.equal(gate.getFix("08")?.verdict, "fixed");
});

test("the next fix reads the unaddressed bad records as its repro", () => {
  const ratings = createReviewRatings();
  ratings.recordTurn({
    callId: "call-1",
    turnId: "turn-1",
    verdict: "bad",
    tag: "robotic",
    note: "Mm felt wrong",
    fillerLine: "Mm.",
    split: null,
  });
  const gate = createFixGate();
  gate.recordFix({
    fixId: "08",
    verdict: "not-fixed",
    stillBroken: "the cover still says Mm on Hi",
    callId: "call-1",
  });
  // The named feeling plus the bad records are the repro the retry addresses.
  const repro = gate.reproForNextFix("08", ratings);
  assert.equal(repro?.stillBroken, "the cover still says Mm on Hi");
  assert.equal(repro?.callId, "call-1");
  assert.equal(repro?.badTurns.length, 1);
  assert.equal(repro?.badTurns[0]?.turnId, "turn-1");
  assert.equal(repro?.badTurns[0]?.tag, "robotic");
});

test("the repro is null unless a not-fixed fix names a reviewed call", () => {
  const ratings = createReviewRatings();
  const gate = createFixGate();
  assert.equal(gate.reproForNextFix("08", ratings), null);
  gate.recordFix({ fixId: "08", verdict: "fixed", callId: "call-1" });
  assert.equal(gate.reproForNextFix("08", ratings), null);
});

test("a fixed mark with no reviewed call does not advance", () => {
  const gate = createFixGate();
  gate.recordFix({ fixId: "08", verdict: "fixed" });
  assert.equal(gate.getFix("08")?.callId, null);
  assert.equal(gate.canAdvance("08"), false);
});

test("the fix-gate save control needs a verdict, and a still-broken note when not-fixed", () => {
  assert.equal(canSaveFixGate(null, ""), false);
  assert.equal(canSaveFixGate("fixed", ""), true);
  assert.equal(canSaveFixGate("not-fixed", ""), false);
  assert.equal(canSaveFixGate("not-fixed", "  still robotic  "), true);
});

test("the fix under review rides beside the review flag", () => {
  assert.equal(fixUnderReview(""), null);
  assert.equal(fixUnderReview("?review=1"), null);
  assert.equal(fixUnderReview("?review=1&fix=08"), "08");
  assert.equal(fixUnderReview("?fix=  "), null);
});

test("the gate artifact serializes beside marks and delivered capture", () => {
  const gate = createFixGate();
  gate.recordFix({
    fixId: "08",
    verdict: "not-fixed",
    stillBroken: "late cover",
    callId: "call-1",
  });
  const artifact = gate.toArtifact("08");
  assert.equal(artifact.schemaVersion, FIX_GATE_SCHEMA_VERSION);
  assert.equal(artifact.fixId, "08");
  assert.equal(artifact.record?.verdict, "not-fixed");
  assert.equal(artifact.blocksNext, true);
});
