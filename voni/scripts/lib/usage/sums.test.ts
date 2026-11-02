/**
 * The ledger's one measured sum: an unmeasured leg contributes nothing, and a
 * measured leg contributes the row's own amount.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { readUsageCall } from "./evidence";
import { sumMeasuredCalls, sumMeasuredLegs } from "./sums";
import { MEASURED, UNMEASURED } from "./test-fixtures";

test("sums only measured legs and never treats an unmeasured leg as zero", () => {
  const call = (fixture: typeof MEASURED) =>
    readUsageCall({
      callId: fixture.callId,
      scenario: fixture.scenario,
      locale: fixture.locale,
      tracePath: `/evidence/${fixture.callId}/trace.jsonl`,
      row: fixture.row,
    });
  const calls = [call(MEASURED), call(UNMEASURED)];
  assert.equal(sumMeasuredCalls(calls), 0.003085 + 0.00241385);
  assert.equal(sumMeasuredLegs(calls[1]!.priced.legs), 0.00241385);
  assert.equal(sumMeasuredLegs([]), 0);
});
