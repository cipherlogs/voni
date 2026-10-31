import test from "node:test";
import assert from "node:assert/strict";
import { SILENCE_CHECK_IN_INSTRUCTIONS, SILENCE_CHECK_IN_MS } from "@/lib/demo/voni-agent";
import { createDemoFloor, DEMO_FLOOR_TICK_MS } from "./demo-floor";

const CHECK_IN = SILENCE_CHECK_IN_INSTRUCTIONS;

function clocked(deps: { allowed?: () => boolean; settled?: () => boolean } = {}) {
  let now = 0;
  const said: string[] = [];
  const floor = createDemoFloor({
    speak: (instructions) => said.push(instructions),
    settled: deps.settled ?? (() => true),
    toolBusy: () => false,
    allowed: deps.allowed ?? (() => true),
    now: () => now,
  });
  const advance = (ms: number) => {
    for (let spent = 0; spent < ms; spent += DEMO_FLOOR_TICK_MS) {
      now += Math.min(DEMO_FLOOR_TICK_MS, ms - spent);
      floor.tick();
    }
  };
  return { floor, said, advance };
}

test("the demo checks in once after the configured silence", () => {
  const { said, advance } = clocked();

  advance(SILENCE_CHECK_IN_MS - DEMO_FLOOR_TICK_MS);
  assert.deepEqual(said, [], "nothing before the configured quiet");

  advance(DEMO_FLOOR_TICK_MS);
  assert.deepEqual(said, [CHECK_IN], "one check-in, through the hidden-note speaker");
});

test("a check-in is not repeated by silence alone; caller speech re-arms it", () => {
  const { floor, said, advance } = clocked();

  advance(SILENCE_CHECK_IN_MS);
  assert.equal(said.length, 1);
  // The agent answers the check-in. Once it ends, quiet alone is not a new
  // check-in: only the caller taking the floor again re-arms it.
  floor.replyStarted();
  floor.replyDone(false);
  advance(SILENCE_CHECK_IN_MS * 3);
  assert.equal(said.length, 1, "one check-in per silence period");

  floor.callerSpeechStarted();
  floor.callerTurnDone();
  // The caller's answer window runs first (CALLER_ANSWER_WAIT_MS), then the
  // configured quiet.
  advance(SILENCE_CHECK_IN_MS + 2_500 + DEMO_FLOOR_TICK_MS);
  assert.equal(said.length, 2, "the caller's next silence gets one more");
});

test("mute, hold or a pending return suppresses the check-in and restarts the quiet clock", () => {
  let allowed = false;
  const { said, advance } = clocked({ allowed: () => allowed });

  advance(SILENCE_CHECK_IN_MS * 2);
  assert.deepEqual(said, [], "no note while the demo cannot take one");

  allowed = true;
  advance(SILENCE_CHECK_IN_MS - DEMO_FLOOR_TICK_MS);
  assert.deepEqual(said, [], "the quiet clock starts when the call can listen again");

  advance(DEMO_FLOOR_TICK_MS);
  assert.deepEqual(said, [CHECK_IN]);
});

test("the check-in waits for the agent's audio to settle", () => {
  let speaking = true;
  const { said, advance } = clocked({ settled: () => !speaking });

  advance(SILENCE_CHECK_IN_MS * 2);
  assert.deepEqual(said, [], "never over the agent");

  speaking = false;
  advance(SILENCE_CHECK_IN_MS + DEMO_FLOOR_TICK_MS);
  assert.deepEqual(said, [CHECK_IN], "it goes out once the floor is free");
});
