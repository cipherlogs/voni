import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { click, clipped, fade, hole, silence, tone } from "./test-pcm";
import {
  CLICK_JUMP,
  detectClicks,
  detectClippedRuns,
  detectDropouts,
  detectFades,
  measureContinuity,
  silentFramesAgainstReference,
} from "./analysis";

/**
 * The audio analyser's seams: decoded PCM in, measured events out. Every
 * fixture is built from a known signal, so a wrong threshold, unit or edge
 * rule makes the test disagree.
 */

test("a hole longer than 20 ms is a dropout with its time range", () => {
  const audio = hole(tone(1), 0.4, 0.44);
  const report = detectDropouts(audio);

  assert.equal(report.count, 1);
  assert.equal(report.events[0]!.atMs, 400);
  assert.ok(
    report.events[0]!.durationMs >= 40 && report.events[0]!.durationMs <= 50,
    `duration ${report.events[0]!.durationMs} ms should be the 40 ms hole at 10 ms resolution`,
  );
  assert.equal(report.longestMs, report.events[0]!.durationMs);
});

test("a hole of 20 ms or shorter is not a dropout", () => {
  assert.equal(detectDropouts(hole(tone(1), 0.4, 0.42)).count, 0);
  assert.equal(detectDropouts(hole(tone(1), 0.4, 0.41)).count, 0);
});

test("a hole in an otherwise silent file is not a dropout", () => {
  assert.equal(detectDropouts(hole(silence(1), 0.2, 0.5)).count, 0);
});

test("a click is a seam and names the time it happened", () => {
  const audio = click(tone(1, { frequency: 100 }), 0.5);
  const report = detectClicks(audio);

  assert.equal(report.count, 1);
  assert.equal(report.events[0]!.atMs, 500);
});

test("a steady tone carries no click", () => {
  assert.equal(detectClicks(tone(1)).count, 0);
});

test("the analyser's click rule is the playout worklet's own POP_JUMP", () => {
  const worklet = readFileSync(
    new URL("../../../../../../public/playout-processor.js", import.meta.url),
    "utf8",
  );
  const match = /const POP_JUMP = ([0-9.]+);/.exec(worklet);
  assert.ok(match, "the worklet must still declare POP_JUMP");
  assert.equal(CLICK_JUMP, Number(match[1]));
});

test("a clipped run is an overrun with its time range", () => {
  const audio = clipped(tone(1), 0.3, 12);
  const report = detectClippedRuns(audio);

  assert.equal(report.count, 1);
  assert.equal(report.events[0]!.atMs, 300);
  assert.ok(report.events[0]!.durationMs > 0);
});

test("a hard fade is measured from speech to silence", () => {
  const audio = fade(tone(1), 0.5, 50);
  const report = detectFades(audio);

  assert.ok(report.count >= 1);
  const longest = Math.max(...report.events.map((event) => event.durationMs));
  assert.ok(longest >= 40 && longest <= 70, `fade ${longest} ms should read the 50 ms ramp`);
});

test("a long fade reads longer than the barge-in bar", () => {
  const report = detectFades(fade(tone(1), 0.5, 200));
  assert.ok(report.longestMs > 120);
});

test("silence against the reference counts the frames the caller should have heard", () => {
  const reference = tone(1);
  const delivered = hole(reference, 0.4, 0.5);

  const report = silentFramesAgainstReference(reference, delivered);
  assert.equal(report.frameMs, 10);
  assert.ok(
    report.count >= 9 && report.count <= 11,
    `a 100 ms hole is about 10 ten-millisecond frames, got ${report.count}`,
  );
  assert.equal(report.windows[0]!.atMs, 400);
});

test("a delivered frame the reference is also silent on is not counted", () => {
  const reference = hole(tone(1), 0.4, 0.5);
  const delivered = hole(reference, 0.4, 0.5);
  assert.equal(silentFramesAgainstReference(reference, delivered).count, 0);
});

test("continuity folds dropouts and clicks into one defect count", () => {
  const audio = click(hole(tone(1), 0.4, 0.45), 0.7);
  const report = measureContinuity(audio);

  assert.equal(report.dropouts.count, 1);
  assert.equal(report.clicks.count, 1);
  assert.equal(report.defectCount, 2);
  assert.equal(report.longestDropoutMs, report.dropouts.longestMs);
});
