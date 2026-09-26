import test from "node:test";
import assert from "node:assert/strict";
import { buildHoldCarryover, HOLD_CAP_S, HoldState, shouldRejoinAfterHold } from "./hold";
import { HOLD_ENTER_LINES, holdEnterInstructions } from "./voni-agent";

const secToMs = (seconds: number) => seconds * 1000;

test("hidden enters hold, visible exits with the held duration", () => {
  const hold = new HoldState();
  assert.equal(hold.holding, false);
  assert.equal(hold.enter(secToMs(10)), true, "first enter reports new");
  assert.equal(hold.holding, true);
  assert.equal(hold.holdSeconds(secToMs(40)), 30);
  assert.equal(hold.exit(secToMs(40)), 30000);
  assert.equal(hold.holding, false);
});

test("double enter and stray exit are no-ops", () => {
  const hold = new HoldState();
  assert.equal(hold.exit(secToMs(5)), null, "exit while idle");
  hold.enter(secToMs(10));
  assert.equal(hold.enter(secToMs(20)), false, "already holding");
  assert.equal(hold.holdSeconds(secToMs(30)), 20, "first enter wins");
  hold.exit(secToMs(30));
});

test("hold expires at the cap", () => {
  const hold = new HoldState();
  hold.enter(0);
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S - 1)), false);
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S)), true);
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S + 60)), true);
});

test("idle hold never expires", () => {
  const hold = new HoldState();
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S + 60)), false);
  assert.equal(hold.holdSeconds(secToMs(999)), 0);
});

test("re-enter after exit starts a fresh stretch", () => {
  const hold = new HoldState();
  hold.enter(secToMs(0));
  hold.exit(secToMs(30));
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S)), false, "old stretch does not linger");
  hold.enter(secToMs(100));
  assert.equal(hold.holdSeconds(secToMs(130)), 30);
});

test("carryover context keeps newest turns and says where to resume", () => {
  const context = buildHoldCarryover([
    { role: "user", text: "My favorite color is blue." },
    { role: "agent", text: "Blue, noted. What does your business do?" },
  ]);
  assert.match(context, /blue/i);
  assert.match(context, /business/i);
  assert.match(context, /do not start over/i);
});

test("carryover with no turns is still a resume cue", () => {
  const context = buildHoldCarryover([]);
  assert.match(context, /resumed|reconnected/i);
});

test("carryover truncates oldest first under the budget", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    role: "user" as const,
    text: `Turn number ${i} with some padding words to fill the budget.`,
  }));
  const context = buildHoldCarryover(turns, 300);
  assert.ok(context.length <= 600, `got ${context.length}`);
  assert.match(context, /Turn number 19/, "newest survives");
  assert.doesNotMatch(context, /Turn number 0/, "oldest is cut");
});

test("a failed resume after a hold return rejoins on transport failure", () => {
  // 1008 refusal, exhausted attempts, resume-fetch failure: the old
  // transport is terminally gone, so restart it with carried context.
  assert.equal(shouldRejoinAfterHold(true, "expired"), true);
  assert.equal(shouldRejoinAfterHold(true, "network"), true);
});

test("a failed resume after a hold return still shows real errors", () => {
  // Mic, auth, config, and rate-limit failures need the visitor to act —
  // a silent restart would loop or strand them.
  assert.equal(shouldRejoinAfterHold(true, "mic"), false);
  assert.equal(shouldRejoinAfterHold(true, "busy-mic"), false);
  assert.equal(shouldRejoinAfterHold(true, "auth"), false);
  assert.equal(shouldRejoinAfterHold(true, "config"), false);
  assert.equal(shouldRejoinAfterHold(true, undefined), false);
});

test("no hold return pending means no silent rejoin, ever", () => {
  assert.equal(shouldRejoinAfterHold(false, "expired"), false);
  assert.equal(shouldRejoinAfterHold(false, "network"), false);
});

test("hold lines rotate, starting with the verified canonical line", () => {
  assert.ok(HOLD_ENTER_LINES.length > 1, "rotation needs variants");
  assert.equal(HOLD_ENTER_LINES[0], "Go ahead, I'll hold.");
  const seen = new Set(
    Array.from({ length: HOLD_ENTER_LINES.length }, (_, i) => holdEnterInstructions(i)),
  );
  assert.equal(seen.size, HOLD_ENTER_LINES.length, "each hold sounds different");
  assert.equal(
    holdEnterInstructions(HOLD_ENTER_LINES.length),
    holdEnterInstructions(0),
    "the pool wraps around",
  );
});

test("every hold turn is fenced to its single line", () => {
  for (let i = 0; i < HOLD_ENTER_LINES.length; i += 1) {
    const instructions = holdEnterInstructions(i);
    assert.match(instructions, /ONLY this one short line/);
    assert.match(instructions, /Do not answer any earlier question/);
  }
});
