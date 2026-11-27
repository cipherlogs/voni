/**
 * The pace planner: a target rate in, the nearest reachable pace out.
 *
 * These tests pin the two things that would make the card dishonest: projecting
 * a rate the queue cannot deliver, and quietly clamping a target instead of
 * saying so.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  describePace,
  paceClicksPerSegment,
  passesFor,
  paceRange,
  planPace,
} from "./pace";
import { CLICKS_PER_SEGMENT_BUDGET } from "./sources";

/** Today's live settings: 15 s passes, five targets, three OSes, 24 h. */
const LIVE = {
  intervalSeconds: 15,
  windowSeconds: 86_400,
  targetCount: 5,
  osCount: 3,
};

test("passes use the exit budget without exceeding it", () => {
  assert.equal(passesFor(5), 1);
  assert.equal(passesFor(3), 2);
  assert.equal(passesFor(2), 3);
  // One target could use all seven; the select offers six, so six it is.
  assert.equal(passesFor(1), 6);
  // A target list wider than the budget still gets one pass: half a pass is
  // not a thing, and the cap already stops the segment asking for more.
  assert.equal(passesFor(9), 1);
});

test("the range is the slowest and fastest gap these settings allow", () => {
  const range = paceRange(LIVE);
  // 600 s gap: 600 + 100 s startup + 15 s segment = 715 s cycles.
  assert.equal(range.minPerDay, 1_800);
  // 15 s gap, but the dead threshold floors at 60 s: 175 s cycles.
  assert.equal(range.maxPerDay, 7_395);
});

test("a reachable target lands on a gap that projects within a tenth", () => {
  const plan = planPace(LIVE, 3_000);

  assert.equal(plan.reachable, true);
  assert.equal(plan.note, null);
  assert.ok(
    Math.abs(plan.projectedPerDay - 3_000) <= 300,
    `projected ${plan.projectedPerDay} must be within 10% of 3,000`,
  );
  assert.equal(plan.passes, 1);
  assert.equal(plan.segmentSeconds, 15);
});

test("asking for more than the ceiling says the ceiling instead of pretending", () => {
  const plan = planPace(LIVE, 10_000);

  assert.equal(plan.reachable, false);
  assert.equal(plan.projectedPerDay, plan.range.maxPerDay);
  assert.match(plan.note ?? "", /10,000\/day is past/);
  assert.match(plan.note ?? "", /ceiling is 7,395\/day/);
  assert.match(plan.note ?? "", /100 s starting up/);
});

test("asking for less than the floor says so, and does not stop the source", () => {
  const plan = planPace(LIVE, 200);

  assert.equal(plan.reachable, false);
  assert.equal(plan.projectedPerDay, plan.range.minPerDay);
  assert.match(plan.note ?? "", /2,000|1,800/);
  assert.match(plan.note ?? "", /Pause the source to stop entirely/);
});

test("a nonsense target falls back to the slowest pace rather than throwing", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = planPace(LIVE, bad);
    assert.equal(plan.targetPerDay, plan.range.minPerDay ?? plan.targetPerDay);
    assert.ok(plan.projectedPerDay > 0);
  }
});

test("the description reads like a sentence, not like settings", () => {
  const plan = planPace(LIVE, 3_000);
  // A 300 s gap is the nearest offered value to 3,000/day at these settings.
  assert.equal(describePace(plan, 15), "1 pass of 15 s each, replaced 5 min after it goes silent");
});

test("clicks per segment never exceeds what the pool pays for", () => {
  const plan = planPace(LIVE, 3_000);
  assert.equal(paceClicksPerSegment(LIVE, plan), 5);
  const narrow = { ...LIVE, targetCount: 2 };
  const narrowPlan = planPace(narrow, 3_000);
  assert.ok(paceClicksPerSegment(narrow, narrowPlan) <= CLICKS_PER_SEGMENT_BUDGET);
});
