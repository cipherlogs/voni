import test from "node:test";
import assert from "node:assert/strict";

import type { ScenarioAttempt } from "../verdict";
import {
  CostBoundError,
  boundPricedCost,
  cutCallIdsFromAttempts,
  evidenceHasCut,
  type RunCostRow,
} from "./index";
import { readPricedRow } from "./priced-cost";

const CALL_ID = "47c04fa7-97ba-4dd7-b6f6-76eaf13718c2";
const CUT_SOURCE =
  "llm.prompt_tokens is unmeasured: no usage chunk was recorded for this turn; " +
  "llm.completion_tokens is unmeasured: no usage chunk was recorded for this turn";

/** The exact row the 2026-11-02 run wrote for a cut mispronounced-email call. */
const CUT_ROW = {
  measured: false,
  totalUsd: null,
  rateTableVersion: "cascade-vendor-rates v1",
  unmeasuredReason: `llm: ${CUT_SOURCE}`,
  legs: {
    stt: {
      measured: true,
      amountUsd: 0.00085,
      unit: "audio_seconds",
      quantity: 17,
      source: "priced from the vendor's reported units",
      units: { audio_seconds: 17 },
    },
    llm: {
      measured: false,
      amountUsd: null,
      unit: "unknown",
      quantity: null,
      source: CUT_SOURCE,
      units: {},
    },
    tts: {
      measured: true,
      amountUsd: 0.002265,
      unit: "multiple",
      quantity: null,
      source: "priced from the vendor's reported units",
      units: { characters: 151, audio_seconds: 11.92, session_seconds: 6 },
    },
  },
};

const MEASURED_ROW = {
  measured: true,
  totalUsd: 0.003115,
  rateTableVersion: "cascade-vendor-rates v1",
  legs: {
    stt: { measured: true, amountUsd: 0.00085, unit: "audio_seconds", quantity: 17 },
    tts: { measured: true, amountUsd: 0.002265, unit: "multiple", quantity: null },
  },
};

function call(cost: unknown): RunCostRow {
  return { callId: CALL_ID, scenario: "mispronounced-email", cost };
}

function attempt(): ScenarioAttempt {
  return {
    scenario: "mispronounced-email",
    repetition: 1,
    locale: "en",
    evidence: {
      ledger: {
        callId: CALL_ID,
        turns: [
          { type: "turn.user_final", callId: CALL_ID, turn: "0:0" },
          { type: "turn.cut", callId: CALL_ID, turn: "0:0", reason: "barge_in" },
        ],
      },
    },
  };
}

test("a cut turn's unpriced leg is a measured lower bound, never a zero or an exact total", () => {
  const bound = boundPricedCost({
    calls: [call(CUT_ROW)],
    cutCallIds: cutCallIdsFromAttempts([attempt()]),
  });

  assert.equal(bound.complete, false);
  assert.equal(bound.usdMeasured, 0.003115, "the bound is the measured legs' own sum");
  assert.equal(bound.callCount, 1);
  assert.deepEqual(bound.unpriced, [
    {
      callId: CALL_ID,
      leg: "llm",
      unit: "unknown",
      source: CUT_SOURCE,
    },
  ]);
});

test("the cut leg stays measured:false with no amount; the pipeline never priced it", () => {
  const priced = readPricedRow(CUT_ROW);
  const llm = priced.legs.find((leg) => leg.leg === "llm");
  assert.ok(llm);
  assert.equal(llm.measured, false);
  assert.equal(llm.amountUsd, null);
  assert.equal(llm.quantity, null);
  assert.match(llm.reasons[0] ?? "", /no usage chunk/);
});

test("a leg unpriced for a reason that is not a cut cannot hide behind one", () => {
  const unexplained = {
    ...CUT_ROW,
    legs: {
      ...CUT_ROW.legs,
      tts: {
        measured: false,
        amountUsd: null,
        unit: "unknown",
        quantity: null,
        source: "the vendor did not report characters",
        units: {},
      },
    },
    unmeasuredReason: "tts: the vendor did not report characters",
  };
  assert.throws(
    () =>
      boundPricedCost({
        calls: [call(unexplained)],
        cutCallIds: cutCallIdsFromAttempts([attempt()]),
      }),
    (error: unknown) => {
      assert.ok(error instanceof CostBoundError);
      assert.equal(error.code, "unexplained-unpriced-leg");
      assert.match(error.message, /characters/);
      assert.match(error.message, /not a cancelled turn/);
      return true;
    },
  );
});

test("a cut leg with no recorded cut refuses instead of assuming one", () => {
  assert.throws(
    () => boundPricedCost({ calls: [call(CUT_ROW)], cutCallIds: new Set() }),
    (error: unknown) => {
      assert.ok(error instanceof CostBoundError);
      assert.equal(error.code, "unexplained-unpriced-leg");
      assert.match(error.message, /no usage chunk/);
      return true;
    },
  );
});

test("a missing priced row refuses the bound; it is never dropped from the count", () => {
  assert.throws(
    () => boundPricedCost({ calls: [call(undefined)], cutCallIds: new Set() }),
    (error: unknown) => {
      assert.ok(error instanceof CostBoundError);
      assert.equal(error.code, "missing-priced-row");
      assert.match(error.message, new RegExp(CALL_ID));
      return true;
    },
  );
});

test("a fully measured run is complete and exact", () => {
  const bound = boundPricedCost({
    calls: [call(MEASURED_ROW)],
    cutCallIds: new Set(),
  });
  assert.equal(bound.complete, true);
  assert.equal(bound.usdMeasured, 0.003115);
  assert.deepEqual(bound.unpriced, []);
});

test("cut detection reads the call's own ledger or trace, never the cost row", () => {
  assert.equal(evidenceHasCut(attempt().evidence), true);
  assert.equal(evidenceHasCut({ ledger: { turns: [] }, trace: { rows: [] } }), false);
  assert.equal(evidenceHasCut({ cost: CUT_ROW }), false);
  assert.deepEqual([...cutCallIdsFromAttempts([attempt()])], [CALL_ID]);
  assert.deepEqual([...cutCallIdsFromAttempts([{ ...attempt(), evidence: {} }])], []);
});
