import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInlineSessionUpdate,
  NATURAL_TURN_DETECTION,
} from "./session";

test("natural turn detection waits out backchannels but keeps barge-in", () => {
  // Fail-closed aligned: sub-350ms bursts (uh-huh, echo) must not cut the
  // agent off, while sustained real interruptions still can.
  assert.equal(NATURAL_TURN_DETECTION.interrupt_response, true);
  assert.equal(NATURAL_TURN_DETECTION.interruption_delay, 350);
});

test("natural endpointing is tighter than the sensitive capture preset", () => {
  // Shorter VAD windows shorten the reply gap; the sensitive preset stays
  // scoped to card-field capture turns.
  assert.ok(NATURAL_TURN_DETECTION.min_silence < 1400);
  assert.ok(NATURAL_TURN_DETECTION.max_silence <= 3000);
});

test("inline session update carries the natural preset to the server", () => {
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "p",
    greeting: "hi",
    voiceId: "v",
    turnDetection: { ...NATURAL_TURN_DETECTION },
  });
  assert.deepEqual(
    (update as { input: { turn_detection: unknown } }).input.turn_detection,
    { ...NATURAL_TURN_DETECTION },
  );
});
