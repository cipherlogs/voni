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

test("natural endpointing caps the uncertain-turn wait at 1200ms", () => {
  // Uncertain turns used to wait out a 3000ms ceiling before finalizing —
  // the bulk of the reply gap. Tighter windows reply sooner; slow speakers
  // who get split are the known cost, and the ceiling is one number to raise.
  assert.equal(NATURAL_TURN_DETECTION.min_silence, 900);
  assert.equal(NATURAL_TURN_DETECTION.max_silence, 1200);
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
