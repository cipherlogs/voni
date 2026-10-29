import test from "node:test";
import assert from "node:assert/strict";
import { buildEndCallSuccess, END_CALL_TOOL, END_CALL_VOICE_TOOL } from "./definitions";

/**
 * The end_call result is pure signal, never speakable text: the model reads
 * tool results as things to say, so any confirmation sentence here gets
 * parroted as narration ("the call has ended"). The goodbye is the
 * closing_line, already spoken — the hang-up sound and screen say the rest.
 */
test("end_call success carries no speakable narration", () => {
  for (const result of [buildEndCallSuccess(false), buildEndCallSuccess(true)]) {
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.hangup, true);
    assert.deepEqual(result.data, {
      ended: true,
      ...(result.dryRun ? { simulated: true } : {}),
    });
    assert.ok(!("confirmation" in result.data), "no confirmation sentence");
    assert.ok(!("closing_line" in result.data), "no spoken line echo");
  }
});

/**
 * The post-hang-up silence ordering rides the tool's response_instructions:
 * the result auto-fires a reply, and that turn is where the model used to
 * narrate the ending. The contract is ordering, not new state — the session
 * still drops any reply after the goodbye (audio, caption, requests).
 */
test("end_call orders silence after the goodbye, in order", () => {
  assert.equal(END_CALL_TOOL, "end_call");
  const instructions = END_CALL_VOICE_TOOL.response_instructions;
  assert.ok(instructions, "end_call carries response_instructions");
  const success = instructions.success;
  // The order matters: it was already spoken, then nothing, then never again.
  const said = success.indexOf("already spoken");
  const nothing = success.search(/say nothing/i);
  const never = success.search(/do not speak after this call/i);
  assert.ok(said >= 0, `names the goodbye as already spoken: ${success}`);
  assert.ok(nothing > said, `orders silence after it: ${success}`);
  assert.ok(never > nothing, `closes the call after that: ${success}`);
  assert.match(instructions.error, /stay on the call/i, "the refusal path keeps the call alive");
  // A pure signal: no speakable body anywhere in the result.
  const result = buildEndCallSuccess(false);
  for (const value of Object.values(result)) {
    if (typeof value === "string") {
      assert.fail(`the result carries speakable text: ${value}`);
    }
  }
});
