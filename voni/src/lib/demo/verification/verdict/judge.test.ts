import test from "node:test";
import assert from "node:assert/strict";

import {
  loadContract,
  type Contract,
  type ContractPropertyEntry,
  type ResolvedThreshold,
} from "../contract";
import { judgeProperty, judgeRun } from "./judge";
import type { BarBinding, PropertyEvidence, PropertyMeasurement } from "./types";

/**
 * The engine's rules, read off `.scratch/demo-verification/spec.md`
 * ("Statistics and the pass rule") and the ticket's acceptance criteria. Every
 * sample below is synthetic; the bars are worked-example literals, never
 * re-derived from the code.
 */

const P50: ResolvedThreshold = { source: "budget-record", key: "p50", value: 350, unit: "ms" };
const P95: ResolvedThreshold = { source: "budget-record", key: "p95", value: 700, unit: "ms" };
const MAX: ResolvedThreshold = { source: "budget-record", key: "max", value: 1200, unit: "ms" };
const BARS: readonly BarBinding[] = [
  { key: "p50", statistic: "p50", comparison: "at-most" },
  { key: "p95", statistic: "p95", comparison: "at-most" },
  { key: "max", statistic: "max", comparison: "at-most" },
];

function entry(
  overrides: Partial<ContractPropertyEntry> & { id: string },
): ContractPropertyEntry {
  const { id, ...rest } = overrides;
  return {
    id,
    family: "turn-taking",
    statement: `statement for ${id}`,
    bar: { text: "p50 <= 350 ms, p95 <= 700 ms, max 1.2 s", numeric: true },
    evidence: "ledger",
    kind: "timing",
    repetitions: 3,
    thresholds: [P50, P95, MAX],
    ...rest,
  };
}

function measurement(
  propertyId: string,
  scenario: string,
  repetition: number,
  samples: readonly number[],
  overrides: Partial<PropertyMeasurement> = {},
): PropertyMeasurement {
  return {
    propertyId,
    scenario,
    repetition,
    outcome: "measured",
    samples,
    citations: [`${scenario}/rep-${repetition}`],
    ...overrides,
  };
}

function evidence(
  propertyId: string,
  measurements: readonly PropertyMeasurement[],
  bars: readonly BarBinding[] = BARS,
): PropertyEvidence {
  return { propertyId, bars, measurements };
}

/** A clean timing run: three scenarios × three repetitions, all well under bar. */
function cleanTimingEvidence(propertyId = "T1"): PropertyEvidence {
  const measurements: PropertyMeasurement[] = [];
  for (const scenario of ["golden-flow", "barge-in", "slow-caller"]) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      measurements.push(measurement(propertyId, scenario, repetition, [180, 240, 320]));
    }
  }
  return evidence(propertyId, measurements);
}

test("a timing property pools its repetitions and passes under every bar", () => {
  const verdict = judgeProperty(entry({ id: "T1" }), cleanTimingEvidence());

  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.reason, "pass");
  assert.equal(verdict.sampleCount, 27, "3 scenarios × 3 repetitions × 3 turns");
  assert.equal(verdict.requiredRepetitions, 3);
  assert.equal(verdict.smallSample, false);
  assert.equal(verdict.scenarios.length, 3);
  // pooled p50 + pooled p95 + one tail check per scenario.
  assert.equal(verdict.checks.length, 5);
  assert.ok(verdict.checks.every((check) => check.passed));
  assert.deepEqual(verdict.summary, { count: 27, p50: 240, p95: 320, max: 320, min: 180 });
  assert.match(verdict.detail, /p50 240ms <= 350ms/);
});

test("a pooled p50 over its bar fails, and the detail names the observed value", () => {
  const measurements = [
    measurement("T1", "golden-flow", 1, [400, 410]),
    measurement("T1", "golden-flow", 2, [420, 430]),
    measurement("T1", "golden-flow", 3, [440, 450]),
  ];
  const verdict = judgeProperty(entry({ id: "T1" }), evidence("T1", measurements));

  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "below-bar");
  assert.match(verdict.detail, /p50 420ms > 350ms/);
  const p50 = verdict.checks.find((check) => check.statistic === "p50");
  assert.ok(p50);
  assert.equal(p50.passed, false);
  assert.equal(p50.scenario, null);
});

test("a pooled p95 over its bar fails even when the p50 is comfortable", () => {
  const measurements = [
    measurement("T1", "golden-flow", 1, [200, 200, 200, 200, 200, 200, 200, 200, 200, 900, 900]),
    measurement("T1", "golden-flow", 2, [200, 200, 200, 200, 200, 200, 200, 200, 200, 900, 900]),
    measurement("T1", "golden-flow", 3, [200, 200, 200, 200, 200, 200, 200, 200, 200, 900, 900]),
  ];
  const verdict = judgeProperty(entry({ id: "T1" }), evidence("T1", measurements));

  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.summary?.p50, 200);
  assert.equal(verdict.summary?.p95, 900);
  const p95 = verdict.checks.find((check) => check.statistic === "p95");
  assert.ok(p95);
  assert.equal(p95.passed, false);
  assert.match(p95.detail, /p95 900ms > 700ms/);
});

test("a single bad scenario cannot be averaged away: its own tail is checked", () => {
  // 27 values, one 1.5 s call, over the 1.2 s max. The pooled p95 stays under
  // its bar (nearest-rank ignores a single outlier among 27), so only the
  // per-scenario tail can catch the bad call.
  const measurements = [
    measurement("T1", "golden-flow", 1, [200, 240, 280]),
    measurement("T1", "golden-flow", 2, [210, 250, 290]),
    measurement("T1", "golden-flow", 3, [220, 260, 300]),
    measurement("T1", "quiet-caller", 1, [300, 320, 340]),
    measurement("T1", "quiet-caller", 2, [310, 330, 350]),
    measurement("T1", "quiet-caller", 3, [320, 340, 360]),
    measurement("T1", "bad-scenario", 1, [1500, 200, 220]),
    measurement("T1", "bad-scenario", 2, [230, 240, 250]),
    measurement("T1", "bad-scenario", 3, [260, 270, 280]),
  ];
  const verdict = judgeProperty(entry({ id: "T1" }), evidence("T1", measurements));

  assert.equal(verdict.status, "FAIL", "the pooled p50/p95 are clean; only the tail fails");
  assert.equal(verdict.reason, "below-bar");
  assert.ok((verdict.summary?.p95 ?? 0) < 700, "the pooled p95 hides the bad call");
  const tail = verdict.checks.find(
    (check) => check.scenario === "bad-scenario" && check.statistic === "max",
  );
  assert.ok(tail);
  assert.equal(tail.passed, false);
  assert.equal(tail.observed, 1500);
  const badScenario = verdict.scenarios.find((scenario) => scenario.scenario === "bad-scenario");
  assert.equal(badScenario?.status, "FAIL");
});

test("a property below its declared repetition count fails and names the count", () => {
  const measurements = [
    measurement("T1", "golden-flow", 1, [200]),
    measurement("T1", "golden-flow", 2, [210]),
    // repetition 3 is missing
  ];
  const verdict = judgeProperty(entry({ id: "T1" }), evidence("T1", measurements));

  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "repetition-shortfall");
  assert.match(verdict.detail, /measured 2 of 3 declared repetitions/);
  assert.match(verdict.detail, /golden-flow/);
  assert.equal(verdict.sampleCount, 2);
});

test("a single call with too few samples is judged by its tail, not its own median", () => {
  // A deterministic property carries one repetition, so its p50 cannot be a
  // median. The tail bar decides; the p50 is never read off one sample.
  const property = entry({
    id: "L4",
    family: "lifecycle",
    kind: "deterministic",
    repetitions: 1,
    thresholds: [P50, P95, MAX],
  });
  const verdict = judgeProperty(
    property,
    evidence(
      "L4",
      [measurement("L4", "golden-flow", 1, [400])],
      BARS,
    ),
  );

  assert.equal(verdict.status, "PASS", "400 ms is over the median bar but under the tail bar");
  assert.equal(verdict.smallSample, true);
  assert.equal(
    verdict.checks.some((check) => check.statistic === "p50"),
    false,
    "a one-sample median is not judged as a median",
  );
  const p95 = verdict.checks.find((check) => check.statistic === "p95");
  assert.ok(p95);
  assert.equal(p95.passed, true);
});

test("an empty sample fails and names the scenario and repetition", () => {
  const measurements = [
    measurement("T1", "golden-flow", 1, [200]),
    measurement("T1", "golden-flow", 2, []),
    measurement("T1", "golden-flow", 3, [210]),
  ];
  const verdict = judgeProperty(entry({ id: "T1" }), evidence("T1", measurements));

  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "empty-sample");
  assert.match(verdict.detail, /golden-flow/);
  assert.match(verdict.detail, /repetition 2/);
});

test("unmeasured, skipped and errored evidence all fail, never skip", () => {
  for (const [outcome, reason] of [
    ["unmeasured", /no measurement/],
    ["skipped", /skipped/],
    ["error", /boom/],
  ] as const) {
    const measurements = [
      measurement("T1", "golden-flow", 1, [200]),
      measurement("T1", "golden-flow", 2, [], { outcome, reason: outcome === "error" ? "boom" : "no measurement" }),
      measurement("T1", "golden-flow", 3, [210]),
    ];
    const verdict = judgeProperty(entry({ id: "T1" }), evidence("T1", measurements));
    assert.equal(verdict.status, "FAIL", `${outcome} must never pass`);
    assert.ok(
      verdict.reason === "unmeasured" || verdict.reason === "skipped" || verdict.reason === "evaluator-error",
      `unexpected reason ${verdict.reason}`,
    );
    assert.match(verdict.detail, reason);
  }
});

test("no evaluator evidence for a property fails closed", () => {
  const verdict = judgeProperty(entry({ id: "T2" }), undefined);
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "no-evaluator");
  assert.match(verdict.detail, /T2/);
});

test("a retry recorded at the same repetition is refused, not averaged", () => {
  const measurements = [
    measurement("T1", "golden-flow", 1, [200]),
    measurement("T1", "golden-flow", 1, [200]),
    measurement("T1", "golden-flow", 2, [210]),
    measurement("T1", "golden-flow", 3, [220]),
  ];
  const verdict = judgeProperty(entry({ id: "T1" }), evidence("T1", measurements));
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "duplicate-repetition");
  assert.match(verdict.detail, /golden-flow/);
});

test("deterministic properties are judged once, on the first repetition", () => {
  const property = entry({
    id: "C8",
    family: "conduct",
    kind: "deterministic",
    repetitions: 1,
    bar: { text: "0", numeric: true },
    thresholds: [{ source: "budget-record", key: "count", value: 0, unit: "count" }],
  });
  const bars: readonly BarBinding[] = [{ key: "count", statistic: "each", comparison: "exact" }];
  const verdict = judgeProperty(
    property,
    evidence(
      "C8",
      [
        measurement("C8", "ending", 1, [0]),
        // The scenario is repeated for timing properties; C8 still judges once.
        measurement("C8", "ending", 2, [0]),
        measurement("C8", "ending", 3, [0]),
      ],
      bars,
    ),
  );

  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.sampleCount, 1);
  assert.equal(verdict.scenarios[0].measuredRepetitions, 1);
});

test("an exact count bar fails on any call that does not match", () => {
  const property = entry({
    id: "L3",
    family: "lifecycle",
    kind: "timing",
    thresholds: [{ source: "budget-record", key: "chime", value: 1, unit: "count" }],
  });
  const bars: readonly BarBinding[] = [{ key: "chime", statistic: "each", comparison: "exact" }];
  const verdict = judgeProperty(
    property,
    evidence(
      "L3",
      [
        measurement("L3", "golden-flow", 1, [1]),
        measurement("L3", "golden-flow", 2, [2]),
        measurement("L3", "golden-flow", 3, [1]),
      ],
      bars,
    ),
  );
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /2/);
});

test("an at-least minimum bar fails when any call is below it", () => {
  const property = entry({
    id: "H3",
    family: "human",
    kind: "behaviour",
    bar: { text: "median >= 4; no call < 3", numeric: true },
    evidence: "panel",
    thresholds: [
      { source: "budget-record", key: "median", value: 4, unit: "score" },
      { source: "budget-record", key: "call-min", value: 3, unit: "score" },
    ],
  });
  const bars: readonly BarBinding[] = [
    { key: "median", statistic: "p50", comparison: "at-least" },
    { key: "call-min", statistic: "min", comparison: "at-least" },
  ];
  const measurements = [
    measurement("H3", "panel-a", 1, [5]),
    measurement("H3", "panel-a", 2, [4]),
    measurement("H3", "panel-a", 3, [5]),
    measurement("H3", "panel-b", 1, [2]),
    measurement("H3", "panel-b", 2, [4]),
    measurement("H3", "panel-b", 3, [4]),
    measurement("H3", "panel-c", 1, [4]),
    measurement("H3", "panel-c", 2, [5]),
    measurement("H3", "panel-c", 3, [5]),
  ];
  const verdict = judgeProperty(property, evidence("H3", measurements, bars));
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "below-bar");
  const callMin = verdict.checks.find(
    (check) => check.key === "call-min" && !check.passed,
  );
  assert.ok(callMin, "every scenario's minimum is checked; the bad one must fail");
  assert.equal(callMin.observed, 2);
  assert.equal(callMin.scenario, "panel-b");
});

test("an unresolved property fails closed even with a perfect measurement", () => {
  const property = entry({
    id: "H6",
    family: "human",
    kind: "behaviour",
    evidence: "judge",
    thresholds: [{ source: "budget-record", key: "kappa", value: 0.65, unit: "kappa" }],
    unresolved: { reason: "no owning evaluator ticket" },
  });
  const verdict = judgeProperty(
    property,
    evidence(
      "H6",
      [
        measurement("H6", "panel-a", 1, [0.9]),
        measurement("H6", "panel-a", 2, [0.9]),
        measurement("H6", "panel-a", 3, [0.9]),
      ],
      [{ key: "kappa", statistic: "p50", comparison: "at-least" }],
    ),
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unresolved");
  assert.match(verdict.detail, /no owning evaluator ticket/);
});

test("a categorical bar is judged from the evaluator's verdict, not skipped", () => {
  const property = entry({
    id: "C9",
    family: "conduct",
    kind: "behaviour",
    bar: { text: "pass", numeric: false },
    thresholds: [],
  });
  const pass = judgeProperty(
    property,
    evidence(
      "C9",
      [
        measurement("C9", "meta", 1, [], { passed: true }),
        measurement("C9", "meta", 2, [], { passed: true }),
        measurement("C9", "meta", 3, [], { passed: true }),
      ],
      [],
    ),
  );
  assert.equal(pass.status, "PASS");
  assert.equal(pass.sampleCount, 3);

  const fail = judgeProperty(
    property,
    evidence(
      "C9",
      [
        measurement("C9", "meta", 1, [], { passed: true }),
        measurement("C9", "meta", 2, [], { passed: false }),
        measurement("C9", "meta", 3, [], { passed: true }),
      ],
      [],
    ),
  );
  assert.equal(fail.status, "FAIL");
  assert.equal(fail.reason, "below-bar");
  assert.equal(fail.scenarios.find((scenario) => scenario.scenario === "meta")?.status, "FAIL");

  const missing = judgeProperty(
    property,
    evidence(
      "C9",
      [
        measurement("C9", "meta", 1, [], { passed: true }),
        measurement("C9", "meta", 2, [], { passed: undefined }),
        measurement("C9", "meta", 3, [], { passed: true }),
      ],
      [],
    ),
  );
  assert.equal(missing.status, "FAIL");
  assert.equal(missing.reason, "categorical-missing-verdict");
});

test("a numeric property with an unbound threshold cannot pass", () => {
  const verdict = judgeProperty(
    entry({ id: "T1" }),
    evidence(
      "T1",
      cleanTimingEvidence().measurements,
      // the max bar is never bound
      [
        { key: "p50", statistic: "p50", comparison: "at-most" },
        { key: "p95", statistic: "p95", comparison: "at-most" },
      ],
    ),
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "bar-unbound");
  assert.match(verdict.detail, /max/);
});

// ── The run's verdict ───────────────────────────────────────────────────────

function probeContract(properties: readonly ContractPropertyEntry[]): Contract {
  const families = [...new Set(properties.map((property) => property.family))];
  return {
    families: families.map((family) => ({
      id: family,
      title: family,
      propertyCount: properties.filter((property) => property.family === family).length,
    })),
    properties,
  };
}

function cleanEvidence(property: ContractPropertyEntry): PropertyEvidence {
  if (!property.bar.numeric) {
    return {
      propertyId: property.id,
      bars: [],
      measurements: Array.from({ length: property.repetitions }, (_, index) =>
        measurement(property.id, "probe", index + 1, [], { passed: true }),
      ),
    };
  }
  const bars: BarBinding[] = property.thresholds.map((threshold) => ({
    key: threshold.key,
    statistic: "max",
    comparison: "at-most",
  }));
  return {
    propertyId: property.id,
    bars,
    measurements: Array.from({ length: property.repetitions }, (_, index) =>
      measurement(property.id, "probe", index + 1, [0]),
    ),
  };
}

const PASSING_CATEGORICAL: ContractPropertyEntry = entry({
  id: "C9",
  family: "conduct",
  kind: "behaviour",
  bar: { text: "pass", numeric: false },
  thresholds: [],
});

test("an eligible run with every property measured is certified", () => {
  const properties = [entry({ id: "T1" }), PASSING_CATEGORICAL];
  const verdict = judgeRun({
    runId: "run-clean",
    contract: probeContract(properties),
    evidence: properties.map(cleanEvidence),
    calls: [{ callId: "call-1", scenario: "probe" }],
  });

  assert.equal(verdict.verdict, "certified");
  assert.equal(verdict.certifiable, true);
  assert.equal(verdict.eligible, true);
  assert.deepEqual(verdict.failedPropertyIds, []);
  assert.match(verdict.detail, /2\/2 properties pass/);
});

test("a failed property makes the run not-demo-ready, never certified", () => {
  const properties = [entry({ id: "T1" }), PASSING_CATEGORICAL];
  const sets = properties.map(cleanEvidence);
  sets[0] = evidence("T1", [
    measurement("T1", "probe", 1, [400]),
    measurement("T1", "probe", 2, [410]),
    measurement("T1", "probe", 3, [420]),
  ]);
  const verdict = judgeRun({
    runId: "run-fail",
    contract: probeContract(properties),
    evidence: sets,
  });

  assert.equal(verdict.verdict, "not-demo-ready");
  assert.equal(verdict.certifiable, false);
  assert.deepEqual(verdict.failedPropertyIds, ["T1"]);
});

test("a provider fallback on any call makes the run ineligible, whatever its numbers say", () => {
  const properties = [entry({ id: "T1" }), PASSING_CATEGORICAL];
  const verdict = judgeRun({
    runId: "run-fallback",
    contract: probeContract(properties),
    evidence: properties.map(cleanEvidence),
    calls: [
      { callId: "call-1", scenario: "probe" },
      { callId: "call-2", scenario: "probe", providerFallback: "stt at connect" },
    ],
  });

  assert.equal(verdict.verdict, "ineligible");
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.certifiable, false, "an ineligible run can never be certified");
  assert.ok(verdict.properties.every((property) => property.status === "PASS"));
  assert.match(verdict.detail, /provider fallback/);
  assert.match(verdict.detail, /stt at connect/);
  assert.match(verdict.detail, /call-2/);
});

test("a budget-stopped call makes the run ineligible by name", () => {
  const properties = [entry({ id: "T1" }), PASSING_CATEGORICAL];
  const verdict = judgeRun({
    runId: "run-budget",
    contract: probeContract(properties),
    evidence: properties.map(cleanEvidence),
    calls: [{ callId: "call-3", scenario: "probe", budgetStop: "nightly ceiling" }],
  });

  assert.equal(verdict.verdict, "ineligible");
  assert.equal(verdict.certifiable, false);
  assert.match(verdict.detail, /budget stop/);
  assert.match(verdict.detail, /nightly ceiling/);
});

test("evidence for an unknown property fails the run by name", () => {
  const properties = [entry({ id: "T1" }), PASSING_CATEGORICAL];
  const verdict = judgeRun({
    runId: "run-unknown",
    contract: probeContract(properties),
    evidence: [...properties.map(cleanEvidence), evidence("ZZ9", [])],
  });

  assert.equal(verdict.verdict, "not-demo-ready");
  assert.deepEqual(verdict.unknownPropertyIds, ["ZZ9"]);
  assert.match(verdict.detail, /ZZ9/);
});

test("two evidence sets for one property are refused, not merged", () => {
  const properties = [entry({ id: "T1" }), PASSING_CATEGORICAL];
  const verdict = judgeRun({
    runId: "run-duplicate",
    contract: probeContract(properties),
    evidence: [
      ...properties.map(cleanEvidence),
      cleanEvidence(properties[0]),
    ],
  });

  assert.equal(verdict.certifiable, false);
  assert.match(verdict.failures.join(" "), /T1/);
  assert.match(verdict.failures.join(" "), /two evidence sets/);
});

test("the loaded 82-property contract fails closed when nothing was measured", async () => {
  const contract = await loadContract();
  const verdict = judgeRun({ runId: "run-empty", contract, evidence: [] });

  assert.equal(contract.properties.length, 82);
  assert.equal(verdict.properties.length, 82);
  assert.equal(verdict.verdict, "not-demo-ready");
  assert.equal(verdict.certifiable, false);
  assert.equal(verdict.failedPropertyIds.length, 82);

  const h6 = verdict.properties.find((property) => property.propertyId === "H6");
  const k8 = verdict.properties.find((property) => property.propertyId === "K8");
  assert.equal(h6?.reason, "unresolved", "H6 has no owning evaluator and must fail the run");
  assert.equal(k8?.reason, "unresolved", "K8's unstated word-error bar must fail the run");
  assert.match(h6?.detail ?? "", /unresolved/);
  assert.match(k8?.detail ?? "", /word error/i);
  assert.equal(
    verdict.properties.find((property) => property.propertyId === "L1")?.reason,
    "no-evaluator",
  );
});
