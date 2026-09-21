import test from "node:test";
import assert from "node:assert/strict";
import { CallTimings } from "./call-timings";

test("records UI-observable marks and reports pause gaps", () => {
  let now = 1000;
  const timings = new CallTimings(() => now);
  timings.mark("startRequested");
  now += 120;
  timings.mark("connecting");
  now += 800;
  timings.mark("listening");
  now += 1500;
  timings.mark("firstAgentTurn");

  const summary = timings.summary();
  assert.equal(summary.marks.startRequested, 1000);
  assert.equal(summary.gapsMs.startToConnecting, 120);
  assert.equal(summary.gapsMs.startToListening, 920);
  // The "pause" the user feels: tap start -> first agent audio/turn.
  assert.equal(summary.gapsMs.startToFirstAgentTurn, 2420);
});

test("first-mark wins and reset clears", () => {
  let now = 0;
  const timings = new CallTimings(() => now);
  timings.mark("startRequested");
  now += 50;
  timings.mark("startRequested");
  assert.equal(timings.marks().length, 1);
  timings.reset();
  assert.equal(timings.marks().length, 0);
  assert.equal(timings.summary().gapsMs.startToFirstAgentTurn, null);
});

test("ignores marks before startRequested except it anchors them", () => {
  const timings = new CallTimings(() => 500);
  timings.mark("listening");
  const summary = timings.summary();
  assert.equal(summary.gapsMs.startToListening, null);
  assert.equal(summary.marks.listening, 500);
});
