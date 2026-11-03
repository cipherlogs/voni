import test from "node:test";
import assert from "node:assert/strict";
import { StakesLadder } from "./stakes-ladder";

test("three off-track turns climb nudge, warning, end", () => {
  const ladder = new StakesLadder();
  assert.equal(ladder.onVerdict(false), null, "on-track turns never climb");
  assert.equal(ladder.onVerdict(true), "nudge");
  assert.equal(ladder.onVerdict(false), null);
  assert.equal(ladder.onVerdict(true), "warning", "strikes are cumulative");
  assert.equal(ladder.onVerdict(true), "end");
  assert.equal(ladder.onVerdict(true), null, "nothing past the end");
  assert.equal(ladder.strikes, 3);
});

test("a complaint turn is answered, never steered: no rung, no strike", () => {
  const ladder = new StakesLadder();
  assert.equal(
    ladder.onVerdict({ offTrack: true, upset: true }),
    null,
    "an upset caller is never handed a note that steers or pitches",
  );
  assert.equal(ladder.strikes, 0, "a complaint is not a strike");
  assert.equal(
    ladder.onVerdict(true),
    "nudge",
    "the ladder still nudges a genuine off-track turn",
  );
});
