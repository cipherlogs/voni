import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../../contract";
import type { Contract } from "../../contract";
import { judgeProperty, judgeRun } from "../judge";
import { evaluateScenarios, loadEvaluators } from "../evaluators";
import type { PropertyEvaluator, ScenarioAttempt } from "../types";
import { judgeRunWithCeiling } from "../../economics/run-verdict";

/**
 * E1-E4 through the real registry and the real verdict engine, on a call's own
 * priced row and persisted end message. An unmeasured cost, an over-ceiling
 * call and a budget stop each fail; the golden path hits neither.
 */

function priced(totalUsd: number, amounts = { stt: 0.003, llm: 0.027, tts: 0.0153 }): Record<string, unknown> {
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
        amountUsd: amounts.stt,
        units: { audio_seconds: 10 },
      },
      llm: {
        unit: "prompt_tokens",
        quantity: 800,
        measured: true,
        source: "vendor usage chunk",
        amountUsd: amounts.llm,
        units: { prompt_tokens: 800 },
      },
      tts: {
        unit: "characters",
        quantity: 240,
        measured: true,
        source: "Termination summary",
        amountUsd: amounts.tts,
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
        amountUsd: 0.015,
        units: { characters: 240 },
      },
    },
  };
}

function goldenEnd(): Record<string, unknown> {
  return {
    type: "end",
    callId: "call-1",
    endedBy: "stop",
    turns: 3,
    cost: priced(0.0453),
  };
}

function budgetStoppedEnd(): Record<string, unknown> {
  return {
    type: "end",
    callId: "call-1",
    endedBy: "budget",
    turns: 2,
    budget: {
      mark: "budget_stopped",
      spendUsd: 0.16,
      ceilingUsd: 0.15,
      measured: true,
      turn: "turn-2",
      unmeasuredReason: "",
      reason:
        "the call's priced spend reached 0.16000000 USD, at or over the 0.15000000 USD per-call ceiling",
    },
  };
}

function ledgerOf(end: Record<string, unknown>): Record<string, unknown> {
  return {
    file: "calls/call-1/end.json",
    end,
    endGap: null,
    turns: [],
    turnIds: [],
    marks: null,
    marksGap: "the protocol adapter has no browser marks",
  };
}

function attempt(evidence: Record<string, unknown>): ScenarioAttempt {
  return { scenario: "golden-flow", repetition: 1, locale: "en", target: "local", evidence };
}

function evaluatorFor(evaluators: readonly PropertyEvaluator[], id: string): PropertyEvaluator {
  const found = evaluators.find((evaluator) => evaluator.propertyId === id);
  assert.ok(found, `no evaluator for ${id}`);
  return found;
}

async function evaluate(
  contract: Contract,
  attemptInput: ScenarioAttempt,
): Promise<Awaited<ReturnType<typeof evaluateScenarios>>> {
  return evaluateScenarios({
    contract,
    evaluators: await loadEvaluators(contract),
    attempts: [attemptInput],
  });
}

function measurement(
  evidence: Awaited<ReturnType<typeof evaluateScenarios>>,
  id: string,
): NonNullable<Awaited<ReturnType<typeof evaluateScenarios>>[number]["measurements"][number]> {
  const found = evidence.find((entry) => entry.propertyId === id)?.measurements[0];
  assert.ok(found, `no measurement for ${id}`);
  return found;
}

test("the registry owns E1-E4 with the frozen bars", async () => {
  const contract = await loadContract();
  const evaluators = await loadEvaluators(contract);
  assert.deepEqual(evaluatorFor(evaluators, "E1").bars, []);
  assert.deepEqual(evaluatorFor(evaluators, "E2").bars, [
    { key: "dvCostPerCallMaxUsd", statistic: "each", comparison: "at-most" },
  ]);
  assert.deepEqual(evaluatorFor(evaluators, "E3").bars, [
    { key: "dvCostFastRunMaxUsd", statistic: "each", comparison: "at-most" },
    { key: "dvCostNightlyRunMaxUsd", statistic: "each", comparison: "at-most" },
    { key: "dvCostFullRunMaxUsd", statistic: "each", comparison: "at-most" },
  ]);
  assert.deepEqual(evaluatorFor(evaluators, "E4").bars, [
    { key: "dvBudgetStopMaxCount", statistic: "each", comparison: "at-most" },
  ]);
});

test("a measured call under the ceiling measures E1, E2 and E4", async () => {
  const contract = await loadContract();
  const evidence = await evaluate(
    contract,
    attempt({ cost: priced(0.0453), ledger: ledgerOf(goldenEnd()) }),
  );
  const e1 = measurement(evidence, "E1");
  assert.equal(e1.outcome, "measured");
  assert.equal(e1.passed, true);
  const e2 = measurement(evidence, "E2");
  assert.deepEqual([...e2.samples], [0.0453]);
  assert.match(e2.detail ?? "", /cascade v1/);
  assert.match(e2.detail ?? "", /stt \$0\.003000/);
  const e4 = measurement(evidence, "E4");
  assert.deepEqual([...e4.samples], [0]);
});

test("an unmeasured priced row fails E1 and leaves E2 unmeasured", async () => {
  const contract = await loadContract();
  const evidence = await evaluate(
    contract,
    attempt({ cost: unmeasuredRow(), ledger: ledgerOf(goldenEnd()) }),
  );
  const e1 = measurement(evidence, "E1");
  assert.equal(e1.outcome, "measured");
  assert.equal(e1.passed, false);
  const e2 = measurement(evidence, "E2");
  assert.equal(e2.outcome, "unmeasured");
  assert.match(e2.reason ?? "", /completion tokens/);
});

test("a call with no priced row fails E1 and E2 closed", async () => {
  const contract = await loadContract();
  const evidence = await evaluate(contract, attempt({ ledger: ledgerOf(goldenEnd()) }));
  assert.equal(measurement(evidence, "E1").outcome, "missing-evidence");
  assert.equal(measurement(evidence, "E2").outcome, "missing-evidence");
});

test("an over-ceiling call fails with the measured amount and the leg breakdown", async () => {
  const contract = await loadContract();
  const evidence = await evaluate(
    contract,
    attempt({ cost: priced(0.16, { stt: 0.02, llm: 0.09, tts: 0.05 }), ledger: ledgerOf(goldenEnd()) }),
  );
  const property = contract.properties.find((entry) => entry.id === "E2");
  assert.ok(property);
  const verdict = judgeProperty(property, evidence.find((entry) => entry.propertyId === "E2"));
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "below-bar");
  assert.match(verdict.detail, /0\.16/);
  assert.match(verdict.detail, /0\.15/);
  assert.match(verdict.detail, /stt \$0\.020000/);
  assert.match(verdict.detail, /llm \$0\.090000/);
  assert.match(verdict.detail, /tts \$0\.050000/);
});

test("a call that opened no session measures E1 and E2 at an honest zero", async () => {
  const zeroRow = {
    type: "cost.priced",
    producer: "demo.verification.browser-adapter",
    rateTableVersion: "cascade-vendor-rates v1",
    measured: true,
    totalUsd: 0,
    legs: {},
    source: "no session opened (the app refused before any vendor call)",
  };
  const contract = await loadContract();
  const evidence = await evaluate(
    contract,
    attempt({ cost: zeroRow, ledger: ledgerOf(goldenEnd()) }),
  );
  const e1 = measurement(evidence, "E1");
  assert.equal(e1.outcome, "measured");
  assert.equal(e1.passed, true);
  assert.match(e1.detail ?? "", /no session opened/);
  const e2 = measurement(evidence, "E2");
  assert.equal(e2.outcome, "measured");
  assert.deepEqual([...e2.samples], [0]);
  assert.match(e2.detail ?? "", /no session opened/);
  assert.match(e2.detail ?? "", /cascade-vendor-rates v1/);

  const { verdict, check } = judgeRunWithCeiling({
    runId: "run-zero",
    contract,
    evidence,
    kind: "fast",
    calls: [
      {
        callId: "call-zero",
        scenario: "resilience-mic-denied",
        cost: zeroRow,
      },
      {
        callId: "call-real",
        scenario: "golden-flow",
        cost: priced(0.0453),
      },
    ],
  });
  assert.equal(check.calls, 2);
  assert.equal(check.usd, 0.0453, "the zero row adds zero, never a price");
  const e3 = verdict.properties.find((entry) => entry.propertyId === "E3");
  assert.equal(e3?.status, "PASS", e3?.detail);
});

test("a zero-leg row that hides a price is not a measured zero", async () => {
  const contract = await loadContract();
  const evidence = await evaluate(
    contract,
    attempt({
      cost: {
        type: "cost.priced",
        rateTableVersion: "cascade-vendor-rates v1",
        measured: true,
        totalUsd: 0.01,
        legs: {},
        source: "no session opened (the app refused before any vendor call)",
      },
      ledger: ledgerOf(goldenEnd()),
    }),
  );
  assert.equal(measurement(evidence, "E1").outcome, "unmeasured");
  assert.equal(measurement(evidence, "E2").outcome, "unmeasured");
});

test("a budget-stopped call measures one stop and fails E4", async () => {
  const contract = await loadContract();
  const evidence = await evaluate(
    contract,
    attempt({ cost: priced(0.16), ledger: ledgerOf(budgetStoppedEnd()) }),
  );
  const e4 = measurement(evidence, "E4");
  assert.deepEqual([...e4.samples], [1]);
  const property = contract.properties.find((entry) => entry.id === "E4");
  assert.ok(property);
  const verdict = judgeProperty(property, evidence.find((entry) => entry.propertyId === "E4"));
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /1/);
  assert.match(verdict.detail, /0/);
  assert.match(verdict.detail, /ceiling/);

  const run = judgeRun({
    runId: "run-1",
    contract,
    evidence,
    calls: [
      {
        callId: "call-1",
        scenario: "golden-flow",
        budgetStop: "the per-call ceiling",
      },
    ],
  });
  assert.equal(run.verdict, "ineligible");
  assert.equal(run.certifiable, false);
  assert.match(run.detail, /budget stop/);
});

test("E3 refuses to judge one call as if it were a whole run", async () => {
  const contract = await loadContract();
  const evidence = await evaluate(
    contract,
    attempt({ cost: priced(0.0453), ledger: ledgerOf(goldenEnd()) }),
  );
  const e3 = measurement(evidence, "E3");
  assert.equal(e3.outcome, "unmeasured");
  assert.match(e3.reason ?? "", /run/);
});

test("the golden path passes E1-E4 with no budget stop and a run inside its ceiling", async () => {
  const contract = await loadContract();
  const attemptInput = attempt({
    cost: priced(0.0453),
    ledger: ledgerOf(goldenEnd()),
  });
  const evidence = await evaluate(contract, attemptInput);
  const { verdict, check } = judgeRunWithCeiling({
    runId: "run-1",
    contract,
    evidence,
    kind: "fast",
    calls: [
      {
        callId: "call-1",
        scenario: "golden-flow",
        cost: attemptInput.evidence.cost,
      },
    ],
    callFacts: [
      {
        callId: "call-1",
        scenario: "golden-flow",
        providerFallback: null,
        budgetStop: null,
      },
    ],
  });
  assert.equal(check.passed, true);
  for (const id of ["E1", "E2", "E3", "E4"]) {
    const property = verdict.properties.find((entry) => entry.propertyId === id);
    assert.equal(property?.status, "PASS", `${id}: ${property?.detail ?? "missing"}`);
    assert.ok((property?.citations.length ?? 0) > 0, `${id} carries no citation`);
  }
  const e3 = verdict.properties.find((entry) => entry.propertyId === "E3");
  assert.deepEqual(e3?.scenarios, []);
  assert.equal(verdict.eligible, true);
});
