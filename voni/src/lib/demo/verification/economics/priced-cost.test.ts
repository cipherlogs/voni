import test from "node:test";
import assert from "node:assert/strict";

import {
  PRICED_COST_ERROR_CODES,
  PricedCostError,
  legBreakdown,
  readPricedRow,
} from "./priced-cost";

/**
 * The priced row is the call's own `cost.priced` trace row, read verbatim. The
 * harness never recomputes a price and never turns an unmeasured leg into a
 * zero.
 */

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "cost.priced",
    producer: "cascade",
    rateTableVersion: "cascade v1",
    measured: true,
    totalUsd: 0.0453,
    legs: {
      stt: {
        unit: "audio_seconds",
        quantity: 12.5,
        measured: true,
        source: "vendor usage frame",
        amountUsd: 0.0031,
        units: { audio_seconds: 12.5 },
      },
      llm: {
        unit: "prompt_tokens",
        quantity: 900,
        measured: true,
        source: "vendor usage chunk",
        amountUsd: 0.027,
        units: { prompt_tokens: 900 },
      },
      tts: {
        unit: "characters",
        quantity: 310,
        measured: true,
        source: "Termination summary",
        amountUsd: 0.0152,
        units: { characters: 310 },
      },
    },
    ...overrides,
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PricedCostError, String(error));
    assert.ok(
      (PRICED_COST_ERROR_CODES as readonly string[]).includes(error.code),
      error.code,
    );
    return error.code;
  }
  assert.fail("expected a PricedCostError");
}

test("a measured priced row is read verbatim, with every leg", () => {
  const cost = readPricedRow(row());
  assert.equal(cost.measured, true);
  assert.equal(cost.totalUsd, 0.0453);
  assert.equal(cost.rateTableVersion, "cascade v1");
  assert.deepEqual(
    cost.legs.map((leg) => [leg.leg, leg.amountUsd]),
    [
      ["stt", 0.0031],
      ["llm", 0.027],
      ["tts", 0.0152],
    ],
  );
  assert.deepEqual(
    cost.legs.map((leg) => [leg.leg, leg.units]),
    [
      ["stt", { audio_seconds: 12.5 }],
      ["llm", { prompt_tokens: 900 }],
      ["tts", { characters: 310 }],
    ],
  );
  assert.equal(cost.unmeasuredReason, null);
});

test("the leg breakdown names each leg's priced amount", () => {
  assert.equal(
    legBreakdown(readPricedRow(row())),
    "stt $0.003100; llm $0.027000; tts $0.015200",
  );
});

test("an unmeasured row keeps its null total and the named reason", () => {
  const cost = readPricedRow(
    row({
      measured: false,
      totalUsd: null,
      rateTableVersion: "cascade v1",
      unmeasuredReason: "llm: the vendor did not report completion tokens",
      legs: {
        stt: {
          unit: "audio_seconds",
          quantity: 12.5,
          measured: true,
          source: "vendor usage frame",
          amountUsd: 0.0031,
          units: { audio_seconds: 12.5 },
        },
        llm: {
          unit: "unknown",
          quantity: null,
          measured: false,
          source: "the vendor did not report completion tokens",
          amountUsd: null,
          units: {},
        },
        tts: {
          unit: "characters",
          quantity: 310,
          measured: true,
          source: "Termination summary",
          amountUsd: 0.0152,
          units: { characters: 310 },
        },
      },
    }),
  );
  assert.equal(cost.measured, false);
  assert.equal(cost.totalUsd, null);
  assert.match(cost.unmeasuredReason ?? "", /completion tokens/);
  assert.match(legBreakdown(cost), /llm unmeasured \(/);
});

test("an unmeasured row may not carry a total; a zero is a price never given", () => {
  assert.equal(
    codeOf(() => readPricedRow(row({ measured: false, totalUsd: 0 }))),
    "malformed-cost",
  );
});

test("a measured row must cite its rate table and carry a finite total", () => {
  assert.equal(
    codeOf(() => readPricedRow(row({ rateTableVersion: null }))),
    "malformed-cost",
  );
  assert.equal(
    codeOf(() => readPricedRow(row({ totalUsd: null }))),
    "missing-total",
  );
  assert.equal(
    codeOf(() => readPricedRow(row({ totalUsd: Number.NaN }))),
    "malformed-cost",
  );
  assert.equal(
    codeOf(() => readPricedRow(row({ totalUsd: -0.01 }))),
    "malformed-cost",
  );
});

test("a measured leg without its priced amount is refused, not read as zero", () => {
  const broken = row();
  const legs = broken.legs as Record<string, Record<string, unknown>>;
  legs.llm = { ...legs.llm, amountUsd: null };
  assert.equal(codeOf(() => readPricedRow(broken)), "malformed-cost");
});

test("a measured zero-leg row is a call that opened no session, not an invented price", () => {
  const cost = readPricedRow(
    row({
      totalUsd: 0,
      legs: {},
      source: "no session opened (the app refused before any vendor call)",
    }),
  );
  assert.equal(cost.measured, true);
  assert.equal(cost.totalUsd, 0);
  assert.deepEqual(cost.legs, []);
  assert.equal(cost.source, "no session opened (the app refused before any vendor call)");
  assert.equal(cost.rateTableVersion, "cascade v1");
  assert.match(legBreakdown(cost), /no session opened/);
});

test("a zero-leg row must price zero and say why no session opened", () => {
  // A zero-leg row is only honest as a measured zero with its reason.
  assert.equal(
    codeOf(() =>
      readPricedRow(
        row({
          totalUsd: 0.01,
          legs: {},
          source: "no session opened (the app refused before any vendor call)",
        }),
      ),
    ),
    "malformed-cost",
  );
  assert.equal(
    codeOf(() => readPricedRow(row({ totalUsd: 0, legs: {} }))),
    "malformed-cost",
  );
  assert.equal(
    codeOf(() =>
      readPricedRow(
        row({
          measured: false,
          totalUsd: null,
          legs: {},
          source: "no session opened (the app refused before any vendor call)",
        }),
      ),
    ),
    "malformed-cost",
  );
});

test("a cost row with no legs, or a non-object, is refused by name", () => {
  assert.equal(codeOf(() => readPricedRow(row({ legs: {} }))), "malformed-cost");
  assert.equal(codeOf(() => readPricedRow(null)), "malformed-cost");
  assert.equal(codeOf(() => readPricedRow("0.04")), "malformed-cost");
  assert.equal(codeOf(() => readPricedRow(row({ measured: "yes" }))), "malformed-cost");
});
