import test from "node:test";
import assert from "node:assert/strict";
import { MUTE_CHECK_IN_S, TALK_BASE_S, TalkClock, WALL_CLOSE_S } from "./talk-clock";

const s = (seconds: number) => seconds * 1000;

test("talk time freezes while muted", () => {
  const clock = new TalkClock(0);
  assert.equal(clock.talkSeconds(s(30)), 30);
  clock.setMuted(true, s(30));
  assert.equal(clock.talkSeconds(s(70)), 30, "40s muted adds nothing");
  clock.setMuted(false, s(70));
  assert.equal(clock.talkSeconds(s(80)), 40);
  assert.equal(clock.remainingSeconds(s(80)), TALK_BASE_S - 40);
});

test("the call is over at base talk time, not base real time", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, s(10));
  clock.setMuted(false, s(60));
  assert.equal(clock.isOver(s(TALK_BASE_S)), false, "50s were muted");
  assert.equal(clock.isOver(s(TALK_BASE_S + 50)), true);
});

test("the wall-clock cap ends the call even while muted", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, s(5));
  assert.equal(clock.isOver(s(WALL_CLOSE_S - 1)), false);
  assert.equal(clock.isOver(s(WALL_CLOSE_S)), true);
});

test("one gentle check-in per mute stretch, at ~20s", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, s(10));
  assert.equal(clock.takeCheckIn(s(10 + MUTE_CHECK_IN_S - 1)), false);
  assert.equal(clock.takeCheckIn(s(10 + MUTE_CHECK_IN_S)), true);
  assert.equal(clock.takeCheckIn(s(60)), false, "never nags twice");
  clock.setMuted(false, s(60));
  assert.equal(clock.takeCheckIn(s(100)), false, "unmuted: nothing due");
  clock.setMuted(true, s(100));
  assert.equal(clock.takeCheckIn(s(100 + MUTE_CHECK_IN_S)), true, "a new mute is a new stretch");
});

test("repeated mute calls do not reset the pause", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, s(10));
  clock.setMuted(true, s(20));
  clock.setMuted(false, s(30));
  assert.equal(clock.talkSeconds(s(30)), 10);
});
