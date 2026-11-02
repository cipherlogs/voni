/**
 * The usage ledger's aggregation rules, proved against the pipeline's own
 * priced rows.
 *
 * A measured row is split into the vendor legs the dashboards bill. An
 * unmeasured leg stays out of every total and appears in the unmeasured
 * section with the row's reason. A measured zero is a zero, not a missing leg.
 * A row whose total contradicts its legs, or which hides an unmeasured leg
 * under a measured total, is a torn row and is refused.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  UsageCliError,
  type UsageCall,
  type UsageRun,
} from "./types";
import { buildLedger, formatLedger } from "./ledger";
import { readUsageCall } from "./evidence";
import {
  MEASURED,
  MEASURED_LLM,
  MEASURED_LLM_ROW,
  MEASURED_ROW,
  MEASURED_ZERO_ROW,
  RATE_TABLE_VERSION,
  UNMEASURED,
  UNMEASURED_ROW,
  ZERO,
} from "./test-fixtures";

function callOf(fixture: {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: string;
  readonly row: unknown;
}): UsageCall {
  return readUsageCall({
    callId: fixture.callId,
    scenario: fixture.scenario,
    locale: fixture.locale,
    tracePath: `/evidence/${fixture.callId}/trace.jsonl`,
    row: fixture.row,
  });
}

function runOf(calls: readonly UsageCall[], runId = "browser-test"): UsageRun {
  return {
    runId,
    kind: "directory",
    calls,
    expectedCalls: calls.length,
    source: `voni/.demo-runs/${runId}`,
  };
}

test("prices a measured call into its Meta and AssemblyAI legs", () => {
  const ledger = buildLedger(runOf([callOf(MEASURED_LLM)]));
  assert.equal(ledger.complete, true);
  assert.equal(ledger.calls.length, 1);
  assert.equal(ledger.zeroCalls, 0);
  assert.equal(ledger.unmeasured.length, 0);
  assert.deepEqual(ledger.rateVersions, [RATE_TABLE_VERSION]);
  assert.equal(ledger.totalUsd, 0.00549885);

  const meta = ledger.vendors.find((vendor) => vendor.vendor === "meta");
  const assembly = ledger.vendors.find((vendor) => vendor.vendor === "assemblyai");
  assert.equal(meta?.usd, 0.00416385);
  assert.equal(meta?.complete, true);
  assert.equal(assembly?.usd, 0.001335);
  assert.equal(assembly?.complete, true);

  const line = (id: string) => ledger.lines.find((entry) => entry.id === id);
  assert.equal(line("stt.audio_seconds")?.quantity, 35);
  assert.equal(line("llm.prompt_tokens")?.quantity, 4859);
  assert.equal(line("llm.completion_tokens")?.quantity, 390);
  assert.equal(line("llm.cached_tokens")?.quantity, 4834);
  assert.equal(line("llm.reasoning_tokens")?.quantity, 342);
  assert.equal(line("tts.characters")?.quantity, 89);
  assert.equal(line("tts.audio_seconds")?.quantity, 6.4);
  assert.equal(line("tts.session_seconds")?.quantity, 33);
  assert.equal(line("tts.audio_seconds")?.rateUsdPerUnit, 0);
  assert.equal(line("stt.audio_seconds")?.rateUsdPerUnit, 0.00005);

  const text = formatLedger(ledger);
  assert.match(text, /Meta/);
  assert.match(text, /AssemblyAI/);
  assert.match(text, /TOTAL \$0\.00549885 across 1 call/);
  assert.match(text, /UNMEASURED\s+none/);
  assert.match(text, /cascade-vendor-rates v1/);
});

test("keeps an unmeasured leg out of every total and names it with its reason", () => {
  const ledger = buildLedger(runOf([callOf(MEASURED), callOf(UNMEASURED), callOf(ZERO)]));
  assert.equal(ledger.complete, false);
  assert.equal(ledger.calls.length, 3);
  assert.equal(ledger.zeroCalls, 1);
  // The unmeasured row's measured llm leg is real money; stt and tts are not.
  assert.equal(ledger.totalUsd, 0.003085 + 0.00241385);
  assert.equal(ledger.unmeasured.length, 2);

  const reasons = ledger.unmeasured.map((entry) => `${entry.leg}:${entry.kind}:${entry.reason}`);
  assert.ok(reasons.some((entry) => entry.startsWith("stt:price:stt.audio_seconds is unmeasured")));
  assert.ok(reasons.some((entry) => entry.startsWith("tts:price:tts.characters is unmeasured")));
  assert.equal(
    ledger.unmeasured.filter((entry) => entry.leg === "tts").length,
    1,
    "one unmeasured leg names its reason once, not once per unit",
  );

  const meta = ledger.vendors.find((vendor) => vendor.vendor === "meta");
  const assembly = ledger.vendors.find((vendor) => vendor.vendor === "assemblyai");
  assert.equal(meta?.complete, false);
  assert.equal(meta?.usd, 0.003085 - 0.001335 + 0.00241385);
  assert.equal(assembly?.complete, false);
  assert.equal(assembly?.usd, 0.001335);

  const text = formatLedger(ledger);
  assert.match(text, /TOTAL \(measured subset\) \$0\.00549885 across 3 calls/);
  assert.match(text, /NOT RECONCILABLE: 2 unmeasured legs/);
  assert.match(text, /stt\.audio_seconds — price unmeasured/);
  assert.match(text, /golden-flow-booking[^\n]*unmeasured/);
  assert.doesNotMatch(text, /unmeasured[^\n]*\$0\.000000/);
});

test("treats a zero-leg measured row as a measured zero, never an unmeasured leg", () => {
  const ledger = buildLedger(runOf([callOf(ZERO)]));
  assert.equal(ledger.complete, true);
  assert.equal(ledger.totalUsd, 0);
  assert.equal(ledger.zeroCalls, 1);
  assert.equal(ledger.unmeasured.length, 0);
  const text = formatLedger(ledger);
  assert.match(text, /TOTAL \$0\.000000 across 1 call/);
  assert.match(text, /the call opened no session/);
  assert.match(text, /UNMEASURED\s+none/);
});

test("refuses a measured row whose total disagrees with its legs", () => {
  const torn = {
    ...MEASURED_ROW,
    totalUsd: 0.009999,
  };
  assert.throws(
    () => buildLedger(runOf([callOf({ ...MEASURED, row: torn })])),
    (error: unknown) =>
      error instanceof UsageCliError &&
      error.code === "torn-row" &&
      /total .* does not equal the sum of its legs/.test(error.message),
  );
});

test("refuses a measured row that hides an unmeasured leg under a total", () => {
  const torn = {
    ...MEASURED_LLM_ROW,
    legs: {
      ...MEASURED_LLM_ROW.legs,
      tts: {
        unit: "unknown",
        quantity: null,
        measured: false,
        source: "the vendor did not report characters",
        amountUsd: null,
        units: {},
      },
    },
  };
  assert.throws(
    () => buildLedger(runOf([callOf({ ...MEASURED_LLM, row: torn })])),
    (error: unknown) =>
      error instanceof UsageCliError &&
      error.code === "torn-row" &&
      /claims a measured total but leaves .* unmeasured/.test(error.message),
  );
});

test("records a priced leg with a missing unit as unmeasured usage, not zero", () => {
  const partial = {
    ...MEASURED_ROW,
    legs: {
      ...MEASURED_ROW.legs,
      tts: {
        unit: "multiple",
        quantity: null,
        measured: true,
        source: "priced from the vendor's reported units",
        amountUsd: 0.001335,
        units: { characters: 89 },
      },
    },
  };
  const ledger = buildLedger(runOf([callOf({ ...MEASURED, row: partial })]));
  assert.equal(ledger.complete, false);
  assert.equal(ledger.totalUsd, 0.003085);
  assert.equal(ledger.unmeasured.length, 2);
  assert.deepEqual(
    ledger.unmeasured.map((entry) => entry.lineId).sort(),
    ["tts.audio_seconds", "tts.session_seconds"],
  );
  assert.ok(ledger.unmeasured.every((entry) => entry.kind === "usage"));
  assert.ok(ledger.unmeasured.every((entry) => /units\./.test(entry.reason)));
});

test("refuses an unknown rate-table version rather than pricing with another", () => {
  const drifted = {
    ...MEASURED_ROW,
    rateTableVersion: "cascade-vendor-rates v99",
  };
  assert.throws(
    () => buildLedger(runOf([callOf({ ...MEASURED, row: drifted })])),
    (error: unknown) =>
      error instanceof UsageCliError &&
      error.code === "missing-rate-table" &&
      /cascade-vendor-rates v99/.test(error.message),
  );
});

test("refuses a leg with no vendor mapping instead of guessing one", () => {
  const unmapped = {
    ...MEASURED_ROW,
    totalUsd: 0.004085,
    legs: {
      ...MEASURED_ROW.legs,
      judge: {
        unit: "tokens",
        quantity: 10,
        measured: true,
        source: "priced from the vendor's reported units",
        amountUsd: 0.001,
        units: { tokens: 10 },
      },
    },
  };
  assert.throws(
    () => buildLedger(runOf([callOf({ ...MEASURED, row: unmapped })])),
    (error: unknown) =>
      error instanceof UsageCliError &&
      error.code === "unknown-vendor" &&
      /judge/.test(error.message),
  );
});

test("groups measured spend by scenario and call", () => {
  const ledger = buildLedger(runOf([callOf(MEASURED), callOf(MEASURED_LLM)]));
  const greeting = ledger.scenarios.find((row) => row.scenario === MEASURED.scenario);
  const booking = ledger.scenarios.find((row) => row.scenario === MEASURED_LLM.scenario);
  assert.equal(greeting?.calls, 1);
  assert.equal(greeting?.usd, 0.003085);
  assert.equal(booking?.calls, 1);
  assert.equal(booking?.usd, 0.00549885);
  assert.equal(ledger.totalUsd, 0.00858385);
  const text = formatLedger(ledger);
  assert.match(text, /PER SCENARIO/);
  assert.match(text, /PER CALL/);
  assert.match(text, /golden-flow-booking/);
});
