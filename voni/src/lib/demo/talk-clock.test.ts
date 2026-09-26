import test from "node:test";
import assert from "node:assert/strict";
import { MUTE_CHECK_IN_S, TALK_BASE_S, TalkClock, WALL_CLOSE_S } from "./talk-clock";

const secToMs = (seconds: number) => seconds * 1000;

test("talk time freezes while muted", () => {
  const clock = new TalkClock(0);
  assert.equal(clock.talkSeconds(secToMs(30)), 30);
  clock.setMuted(true, secToMs(30));
  assert.equal(clock.talkSeconds(secToMs(70)), 30, "40s muted adds nothing");
  clock.setMuted(false, secToMs(70));
  assert.equal(clock.talkSeconds(secToMs(80)), 40);
  assert.equal(clock.remainingSeconds(secToMs(80)), TALK_BASE_S - 40);
});

test("the call is over at base talk time, not base real time", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, secToMs(10));
  clock.setMuted(false, secToMs(60));
  assert.equal(clock.isOver(secToMs(TALK_BASE_S)), false, "50s were muted");
  assert.equal(clock.isOver(secToMs(TALK_BASE_S + 50)), true);
});

test("the wall-clock cap ends the call even while muted", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, secToMs(5));
  assert.equal(clock.isOver(secToMs(WALL_CLOSE_S - 1)), false);
  assert.equal(clock.isOver(secToMs(WALL_CLOSE_S)), true);
});

test("one gentle check-in per mute stretch, at ~20s", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, secToMs(10));
  assert.equal(clock.takeCheckIn(secToMs(10 + MUTE_CHECK_IN_S - 1)), false);
  assert.equal(clock.takeCheckIn(secToMs(10 + MUTE_CHECK_IN_S)), true);
  assert.equal(clock.takeCheckIn(secToMs(60)), false, "never nags twice");
  clock.setMuted(false, secToMs(60));
  assert.equal(clock.takeCheckIn(secToMs(100)), false, "unmuted: nothing due");
  clock.setMuted(true, secToMs(100));
  assert.equal(clock.takeCheckIn(secToMs(100 + MUTE_CHECK_IN_S)), true, "a new mute is a new stretch");
});

test("repeated mute calls do not reset the pause", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, secToMs(10));
  clock.setMuted(true, secToMs(20));
  clock.setMuted(false, secToMs(30));
  assert.equal(clock.talkSeconds(secToMs(30)), 10);
});

test("talk time freezes while on hold", () => {
  const clock = new TalkClock(0);
  assert.equal(clock.talkSeconds(secToMs(30)), 30);
  clock.setHeld(true, secToMs(30));
  assert.equal(clock.talkSeconds(secToMs(70)), 30, "40s on hold adds nothing");
  clock.setHeld(false, secToMs(70));
  assert.equal(clock.talkSeconds(secToMs(80)), 40);
});

test("mute and hold overlap counts once, not twice", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, secToMs(10));
  clock.setHeld(true, secToMs(20));
  clock.setMuted(false, secToMs(30));
  clock.setHeld(false, secToMs(40));
  // Paused 10→40 continuously: 30s paused, 10s talk at 40s wall.
  assert.equal(clock.talkSeconds(secToMs(40)), 10);
  assert.equal(clock.talkSeconds(secToMs(50)), 20);
});

test("un-holding while muted stays paused", () => {
  const clock = new TalkClock(0);
  clock.setMuted(true, secToMs(10));
  clock.setHeld(true, secToMs(20));
  clock.setHeld(false, secToMs(30));
  assert.equal(clock.talkSeconds(secToMs(40)), 10, "still muted, still paused");
  clock.setMuted(false, secToMs(40));
  assert.equal(clock.talkSeconds(secToMs(50)), 20);
});

test("hold does not arm the mute check-in", () => {
  const clock = new TalkClock(0);
  clock.setHeld(true, secToMs(10));
  assert.equal(clock.takeCheckIn(secToMs(10 + MUTE_CHECK_IN_S)), false);
  clock.setHeld(false, secToMs(60));
  assert.equal(clock.takeCheckIn(secToMs(60)), false);
});

test("repeated hold calls do not reset the pause", () => {
  const clock = new TalkClock(0);
  clock.setHeld(true, secToMs(10));
  clock.setHeld(true, secToMs(20));
  clock.setHeld(false, secToMs(30));
  assert.equal(clock.talkSeconds(secToMs(30)), 10);
});

test("an extension raises the talk limit, never the wall cap", () => {
  const clock = new TalkClock(0);
  assert.equal(clock.isOver(secToMs(TALK_BASE_S), 240), false);
  assert.equal(clock.remainingSeconds(secToMs(TALK_BASE_S), 240), 240 - TALK_BASE_S);
  assert.equal(clock.isOver(secToMs(240), 240), true);
  clock.setMuted(true, secToMs(1));
  assert.equal(clock.isOver(secToMs(WALL_CLOSE_S), 420), true);
});
