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
