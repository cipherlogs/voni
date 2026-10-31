import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../contract";
import { judgeRun } from "../verdict";
import { judgeRunWithCeiling } from "./run-verdict";
import {
  RUN_CEILING_KEYS,
  RUN_KINDS,
  RunCeilingError,
  contractForRunCeiling,
  preflightRunCeiling,
  runCeilingEvidence,
  scopeRunToCeiling,
  settleRunCeiling,
} from "./run-ceiling";

/**
 * Run ceilings are the contract's own, resolved from the frozen budget record.
 * A run is checked before it starts and against the calls' own priced rows when
 * it ends; an unmeasured call has no total, and a breach fails.
 */

function priced(totalUsd: number): Record<string, unknown> {
  return {
    type: "cost.priced",
    producer: "cascade",
    rateTableVersion: "cascade v1",
    measured: true,
    totalUsd,
    legs: {
      stt: {
        unit: "audio_seconds",
        quantity: 10,
        measured: true,
        source: "vendor usage frame",
        amountUsd: totalUsd / 3,
        units: { audio_seconds: 10 },
      },
      llm: {
        unit: "prompt_tokens",
        quantity: 800,
        measured: true,
        source: "vendor usage chunk",
        amountUsd: totalUsd / 3,
        units: { prompt_tokens: 800 },
      },
      tts: {
        unit: "characters",
        quantity: 240,
        measured: true,
        source: "Termination summary",
        amountUsd: totalUsd / 3,
        units: { characters: 240 },
      },
    },
  };
}

function unmeasuredRow(): Record<string, unknown> {
  return {
    type: "cost.priced",
    producer: "cascade",
    rateTableVersion: "cascade v1",
    measured: false,
    totalUsd: null,
    unmeasuredReason: "llm: the vendor did not report completion tokens",
    legs: {
      stt: {
        unit: "audio_seconds",
        quantity: 10,
        measured: true,
        source: "vendor usage frame",
        amountUsd: 0.003,
        units: { audio_seconds: 10 },
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
        quantity: 240,
        measured: true,
        source: "Termination summary",
        amountUsd: 0.02,
        units: { characters: 240 },
      },
    },
  };
}

function close(actual: number | null, expected: number): void {
  assert.ok(actual !== null, "expected a measured value");
  assert.ok(Math.abs(actual - expected) < 1e-9, `${String(actual)} != ${expected}`);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof RunCeilingError, String(error));
    return error.code;
  }
  assert.fail("expected a RunCeilingError");
}

test("the run kinds are the spec's three, each bound to its frozen ceiling", async () => {
  const contract = await loadContract();
  assert.deepEqual([...RUN_KINDS], ["fast", "nightly", "full"]);
  const e3 = contract.properties.find((property) => property.id === "E3");
  assert.deepEqual(
    e3?.thresholds.map((threshold) => [threshold.key, threshold.value]),
    [
      ["dvCostFastRunMaxUsd", 2],
      ["dvCostNightlyRunMaxUsd", 15],
      ["dvCostFullRunMaxUsd", 45],
    ],
  );
  assert.equal(RUN_CEILING_KEYS.nightly, "dvCostNightlyRunMaxUsd");
});

test("a planned run is checked before it starts, against its own ceiling", async () => {
  const contract = await loadContract();
  const fast = preflightRunCeiling({ kind: "fast", contract, plannedCalls: 10 });
  assert.equal(fast.phase, "before");
  assert.equal(fast.key, "dvCostFastRunMaxUsd");
  assert.equal(fast.ceilingUsd, 2);
  assert.equal(fast.passed, true);
  close(fast.usd, 1.5);

  const nightly = preflightRunCeiling({ kind: "nightly", contract, plannedCalls: 88 });
  assert.equal(nightly.passed, true);
  close(nightly.usd, 13.2);
  assert.ok(nightly.usd !== null && nightly.usd <= 15);

  const full = preflightRunCeiling({ kind: "full", contract, plannedCalls: 264 });
  assert.equal(full.passed, true);
  close(full.usd, 39.6);
  assert.ok(full.usd !== null && full.usd <= 45);
});

test("a plan that cannot fit its ceiling is refused before any call", async () => {
  const contract = await loadContract();
  const check = preflightRunCeiling({ kind: "fast", contract, plannedCalls: 14 });
  assert.equal(check.passed, false);
  close(check.usd, 2.1);
  assert.match(check.detail, /14/);
  assert.match(check.detail, /2\.1/);
  assert.match(check.detail, /2/);
});

test("the end check sums the calls' own totals, never a recomputed price", async () => {
  const contract = await loadContract();
  const check = settleRunCeiling({
    kind: "fast",
    contract,
    calls: [
      { callId: "call-1", scenario: "golden-flow", cost: priced(0.05) },
      { callId: "call-2", scenario: "golden-returning", cost: priced(0.12) },
      { callId: "call-3", scenario: "goodbye-drain", cost: priced(0.03) },
    ],
  });
  assert.equal(check.phase, "end");
  assert.equal(check.passed, true);
  assert.equal(check.calls, 3);
  close(check.usd, 0.2);
});

test("a run over its ceiling fails with the spent amount and the ceiling", async () => {
  const contract = await loadContract();
  const check = settleRunCeiling({
    kind: "fast",
    contract,
    calls: [
      { callId: "call-1", scenario: "golden-flow", cost: priced(0.8) },
      { callId: "call-2", scenario: "golden-returning", cost: priced(0.9) },
      { callId: "call-3", scenario: "goodbye-drain", cost: priced(0.4) },
    ],
  });
  assert.equal(check.passed, false);
  close(check.usd, 2.1);
  assert.match(check.detail, /2\.1/);
  assert.match(check.detail, /2/);
});

test("an unmeasured call leaves the run with no total and fails closed", async () => {
  const contract = await loadContract();
  const check = settleRunCeiling({
    kind: "nightly",
    contract,
    calls: [
      { callId: "call-1", scenario: "golden-flow", cost: priced(0.05) },
      { callId: "call-2", scenario: "slow-tool", cost: unmeasuredRow() },
      { callId: "call-3", scenario: "golden-returning" },
    ],
  });
  assert.equal(check.passed, false);
  assert.equal(check.usd, null);
  assert.deepEqual([...check.unmeasuredCalls], ["call-2", "call-3"]);
  assert.match(check.detail, /call-2/);
  assert.match(check.detail, /call-3/);
  assert.match(check.detail, /unmeasured/);
});

test("an unknown run kind or a missing ceiling is refused by name", async () => {
  const contract = await loadContract();
  assert.equal(
    codeOf(() =>
      preflightRunCeiling({ kind: "weekly" as never, contract, plannedCalls: 10 }),
    ),
    "unknown-run-kind",
  );
  assert.equal(
    codeOf(() => preflightRunCeiling({ kind: "fast", contract, plannedCalls: 0 })),
    "invalid-plan",
  );
  const noE3 = {
    families: contract.families,
    properties: contract.properties.filter((property) => property.id !== "E3"),
  };
  assert.equal(
    codeOf(() => preflightRunCeiling({ kind: "fast", contract: noE3, plannedCalls: 10 })),
    "missing-ceiling",
  );
});

test("a run is judged against the ceiling that applies to its own kind", async () => {
  const contract = await loadContract();
  const calls = [
    { callId: "call-1", scenario: "golden-flow", cost: priced(0.8) },
    { callId: "call-2", scenario: "golden-returning", cost: priced(0.9) },
    { callId: "call-3", scenario: "goodbye-drain", cost: priced(0.4) },
  ];
  const scoped = scopeRunToCeiling({ contract, evidence: [], kind: "nightly", calls });
  assert.deepEqual(
    scoped.contract.properties
      .find((property) => property.id === "E3")
      ?.thresholds.map((threshold) => threshold.key),
    ["dvCostNightlyRunMaxUsd"],
  );
  assert.deepEqual(
    scoped.evidence.find((entry) => entry.propertyId === "E3")?.bars,
    [{ key: "dvCostNightlyRunMaxUsd", statistic: "each", comparison: "at-most" }],
  );
  const verdict = judgeRun({ runId: "run-1", contract: scoped.contract, evidence: scoped.evidence });
  const e3 = verdict.properties.find((property) => property.propertyId === "E3");
  assert.equal(e3?.status, "PASS");
  assert.equal(e3?.reason, "pass");

  const fast = scopeRunToCeiling({ contract, evidence: [], kind: "fast", calls });
  const fastVerdict = judgeRun({
    runId: "run-2",
    contract: fast.contract,
    evidence: fast.evidence,
  });
  const fastE3 = fastVerdict.properties.find((property) => property.propertyId === "E3");
  assert.equal(fastE3?.status, "FAIL");
  assert.equal(fastE3?.reason, "below-bar");
  assert.match(fastE3?.detail ?? "", /2\.1/);
});

test("an unmeasured run fails E3 rather than passing on a partial sum", async () => {
  const contract = await loadContract();
  const calls = [
    { callId: "call-1", scenario: "golden-flow", cost: priced(0.05) },
    { callId: "call-2", scenario: "slow-tool", cost: unmeasuredRow() },
  ];
  const scoped = scopeRunToCeiling({ contract, evidence: [], kind: "fast", calls });
  const verdict = judgeRun({ runId: "run-1", contract: scoped.contract, evidence: scoped.evidence });
  const e3 = verdict.properties.find((property) => property.propertyId === "E3");
  assert.equal(e3?.status, "FAIL");
  assert.equal(e3?.reason, "unmeasured");
  assert.match(e3?.detail ?? "", /call-2/);
});

test("narrowing the contract for a run leaves every other property alone", async () => {
  const contract = await loadContract();
  const scoped = contractForRunCeiling(contract, "full");
  assert.equal(scoped.properties.length, contract.properties.length);
  for (const property of contract.properties) {
    if (property.id === "E3") continue;
    assert.equal(
      scoped.properties.find((entry) => entry.id === property.id),
      property,
    );
  }
});

test("a settled over-ceiling run is not-demo-ready and E3 carries no fake scenario", async () => {
  const contract = await loadContract();
  const calls = [
    { callId: "call-1", scenario: "golden-flow", cost: priced(0.8) },
    { callId: "call-2", scenario: "golden-returning", cost: priced(0.9) },
    { callId: "call-3", scenario: "goodbye-drain", cost: priced(0.4) },
  ];
  const { verdict, check } = judgeRunWithCeiling({
    runId: "run-1",
    contract,
    evidence: [],
    kind: "fast",
    calls,
  });
  assert.equal(check.passed, false);
  assert.equal(verdict.verdict, "not-demo-ready");
  assert.equal(verdict.certifiable, false);
  const e3 = verdict.properties.find((property) => property.propertyId === "E3");
  assert.equal(e3?.status, "FAIL");
  assert.deepEqual(e3?.scenarios, []);
  assert.ok((e3?.citations.length ?? 0) > 0);
  assert.match(e3?.detail ?? "", /2\.1/);
});

test("run evidence cannot be built before the run has settled", async () => {
  const contract = await loadContract();
  const before = preflightRunCeiling({ kind: "fast", contract, plannedCalls: 10 });
  assert.equal(codeOf(() => runCeilingEvidence(before)), "not-settled");
});
