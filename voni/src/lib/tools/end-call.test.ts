import test from "node:test";
import assert from "node:assert/strict";
import { buildEndCallSuccess } from "./execute";

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
