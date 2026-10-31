/**
 * The verdict engine: judge one property from its measurements, then judge the
 * whole run.
 *
 * The rules are the spec's, not tunable here: a property fails unless every
 * declared repetition measured a value and every bar passed; timing samples are
 * pooled to p50 and p95 and each scenario's own tail is checked separately; a
 * median is only judged once there are enough samples for one; an unresolved,
 * unmeasured, skipped or errored property fails. A fallback-contaminated or
 * budget-stopped call makes the run ineligible, and an ineligible run can never
 * be certified.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Statistics and the pass rule".
 */

import type { Contract, ContractPropertyEntry, ThresholdSource } from "../contract";
import {
  SMALL_SAMPLE_FLOOR,
  compareToBudget,
  comparisonSymbol,
  statisticValue,
  summarizeSamples,
  type SampleSummary,
  type Statistic,
} from "./statistics";
import type {
  BarBinding,
  CallEligibilityFact,
  PropertyEvidence,
  PropertyMeasurement,
  PropertyStatus,
  PropertyVerdict,
  PropertyVerdictReason,
  RunEligibilityVerdict,
  RunInput,
  RunVerdict,
  RunVerdictValue,
  ScenarioVerdict,
  ThresholdCheck,
} from "./types";

/** The outcome a measurement must have to be judged. */
function outcomeReason(measurement: PropertyMeasurement): PropertyVerdictReason | null {
  switch (measurement.outcome) {
    case "measured":
      return null;
    case "unmeasured":
      return "unmeasured";
    case "skipped":
      return "skipped";
    case "error":
      return "evaluator-error";
    case "missing-evidence":
      return "missing-evidence";
  }
}

function formatValue(value: number, unit: string): string {
  if (unit === "" || unit === "count" || unit === "ratio" || unit === "score" || unit === "kappa") {
    return String(value);
  }
  return `${value}${unit}`;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function baseVerdict(property: ContractPropertyEntry): Omit<PropertyVerdict, "status" | "reason" | "detail"> {
  return {
    propertyId: property.id,
    family: property.family,
    statement: property.statement,
    bar: property.bar.text,
    barNumeric: property.bar.numeric,
    kind: property.kind,
    evidence: property.evidence,
    sampleCount: 0,
    requiredRepetitions: property.repetitions,
    smallSample: false,
    summary: null,
    scenarios: [],
    checks: [],
    citations: [],
    gaps: property.gaps ?? [],
  };
}

function failed(
  property: ContractPropertyEntry,
  reason: PropertyVerdictReason,
  detail: string,
): PropertyVerdict {
  return { ...baseVerdict(property), status: "FAIL", reason, detail };
}

function thresholdFor(property: ContractPropertyEntry, key: string) {
  return property.thresholds.find((threshold) => threshold.key === key);
}

/**
 * A numeric bar must be fully bound: every declared key has exactly one
 * binding, and no binding may name a key the contract did not resolve.
 */
function barProblem(
  property: ContractPropertyEntry,
  bars: readonly BarBinding[],
): string | null {
  if (!property.bar.numeric) {
    return bars.length === 0
      ? null
      : `categorical bar ${property.id} must not bind a numeric threshold`;
  }
  const bound = new Set<string>();
  for (const bar of bars) {
    if (bound.has(bar.key)) {
      return `threshold "${bar.key}" is bound twice for ${property.id}`;
    }
    bound.add(bar.key);
    if (thresholdFor(property, bar.key) === undefined) {
      return `threshold "${bar.key}" is not a bar of ${property.id}`;
    }
  }
  for (const threshold of property.thresholds) {
    if (!bound.has(threshold.key)) {
      return `threshold "${threshold.key}" is declared by ${property.id} but no evaluator binds it`;
    }
  }
  return null;
}

/** The repetitions a property's plan consumes, in judging order. */
function plannedMeasurements(
  property: ContractPropertyEntry,
  measurements: readonly PropertyMeasurement[],
): { selected: PropertyMeasurement[]; missing: number[] } {
  const required = property.repetitions;
  const selected = measurements.filter(
    (measurement) =>
      measurement.repetition >= 1 && measurement.repetition <= required,
  );
  const present = new Set(selected.map((measurement) => measurement.repetition));
  const missing: number[] = [];
  for (let repetition = 1; repetition <= required; repetition += 1) {
    if (!present.has(repetition)) missing.push(repetition);
  }
  return { selected, missing };
}

function check(
  input: {
    property: ContractPropertyEntry;
    bar: BarBinding;
    statistic: Statistic;
    observed: number;
    scenario: string | null;
    locale?: string;
    note?: string;
  },
): ThresholdCheck {
  const threshold = thresholdFor(input.property, input.bar.key);
  if (threshold === undefined) {
    throw new Error(`unbound threshold "${input.bar.key}" for ${input.property.id}`);
  }
  const passed = compareToBudget(input.observed, threshold.value, input.bar.comparison);
  const scope =
    input.scenario === null ? "pooled" : `scenario "${input.scenario}"`;
  const symbol = passed
    ? comparisonSymbol(input.bar.comparison)
    : input.bar.comparison === "at-most"
      ? ">"
      : input.bar.comparison === "at-least"
        ? "<"
        : "!=";
  return {
    key: input.bar.key,
    source: threshold.source as ThresholdSource,
    statistic: input.statistic,
    comparison: input.bar.comparison,
    budget: threshold.value,
    unit: threshold.unit,
    observed: input.observed,
    scenario: input.scenario,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    passed,
    detail:
      `${scope} ${input.statistic} ${formatValue(input.observed, threshold.unit)} ` +
      `${symbol} ${formatValue(threshold.value, threshold.unit)}`,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
}

/** Judge every bar against the pooled sample and each scenario's own tail. */
function numericChecks(
  property: ContractPropertyEntry,
  bars: readonly BarBinding[],
  summary: SampleSummary,
  byScenario: ReadonlyMap<string, { measurements: PropertyMeasurement[]; samples: number[]; locale?: string }>,
): { checks: ThresholdCheck[]; smallSample: boolean; notes: string[] } {
  const checks: ThresholdCheck[] = [];
  const notes: string[] = [];
  const smallSample = summary.count < SMALL_SAMPLE_FLOOR;

  for (const bar of bars) {
    if (bar.statistic === "p50") {
      if (!smallSample) {
        checks.push(
          check({
            property,
            bar,
            statistic: "p50",
            observed: summary.p50,
            scenario: null,
          }),
        );
        continue;
      }
      // Fewer than the floor: a median is not a median. The property's tail
      // decides. When an explicit p95/max/min bar exists it is already checked;
      // otherwise the p50 bar itself is used as the tail, which is strict.
      notes.push(
        `small sample (n=${summary.count} < ${SMALL_SAMPLE_FLOOR}): p50 is not judged; the ` +
          `scenario ${bar.comparison === "at-least" ? "minimum" : "maximum"} is the tail`,
      );
      // A p50 at-most bar is covered by a p95/max tail; a p50 at-least bar by a
      // min floor. Without one, the p50 bar itself is applied to the worst call.
      const covered =
        bar.comparison === "at-least"
          ? bars.some((other) => other.statistic === "min")
          : bars.some(
              (other) => other.statistic === "p95" || other.statistic === "max",
            );
      if (covered) continue;
      const statistic: Statistic = bar.comparison === "at-least" ? "min" : "max";
      for (const [scenario, entry] of byScenario) {
        checks.push(
          check({
            property,
            bar,
            statistic,
            observed: statistic === "max" ? Math.max(...entry.samples) : Math.min(...entry.samples),
            scenario,
            locale: entry.locale,
            note: "small sample: judged against the tail, not a per-call median",
          }),
        );
      }
      continue;
    }

    if (bar.statistic === "p95") {
      checks.push(
        check({
          property,
          bar,
          statistic: "p95",
          observed: summary.p95,
          scenario: null,
        }),
      );
      continue;
    }

    // max, min and each are per-scenario: a single call is judged against its
    // own tail, never a pooled median that could hide it.
    for (const [scenario, entry] of byScenario) {
      if (entry.samples.length === 0) continue;
      let observed: number;
      if (bar.statistic === "each") {
        const failing = entry.samples.find(
          (sample) => !compareToBudget(sample, thresholdFor(property, bar.key)?.value ?? NaN, bar.comparison),
        );
        observed = failing ?? entry.samples[0];
      } else {
        observed = statisticValue(summarizeSamples(entry.samples) as SampleSummary, bar.statistic);
      }
      checks.push(
        check({
          property,
          bar,
          statistic: bar.statistic,
          observed,
          scenario,
          locale: entry.locale,
        }),
      );
    }
  }

  return { checks, smallSample, notes };
}

function scenarioFailure(
  scenario: string,
  locale: string | undefined,
  measurements: readonly PropertyMeasurement[],
  required: number,
  numeric: boolean,
): ScenarioVerdict | null {
  for (const measurement of measurements) {
    const reason = outcomeReason(measurement);
    if (reason === null) continue;
    const detail =
      `scenario "${scenario}" repetition ${measurement.repetition}: ` +
      `${reason}${measurement.reason ? ` — ${measurement.reason}` : ""}`;
    return {
      scenario,
      ...(locale === undefined ? {} : { locale }),
      status: "FAIL",
      reason,
      measuredRepetitions: measurements.length,
      requiredRepetitions: required,
      sampleCount: measurements.reduce((sum, item) => sum + item.samples.length, 0),
      citations: unique(measurements.flatMap((item) => item.citations)),
      detail,
    };
  }
  if (!numeric) {
    const missing = measurements.find((item) => typeof item.passed !== "boolean");
    if (missing !== undefined) {
      return {
        scenario,
        ...(locale === undefined ? {} : { locale }),
        status: "FAIL",
        reason: "categorical-missing-verdict",
        measuredRepetitions: measurements.length,
        requiredRepetitions: required,
        sampleCount: measurements.length,
        citations: unique(measurements.flatMap((item) => item.citations)),
        detail:
          `scenario "${scenario}" repetition ${missing.repetition} carries no pass/fail ` +
          "verdict for a categorical bar",
      };
    }
    const failing = measurements.find((item) => item.passed === false);
    if (failing !== undefined) {
      return {
        scenario,
        ...(locale === undefined ? {} : { locale }),
        status: "FAIL",
        reason: "below-bar",
        measuredRepetitions: measurements.length,
        requiredRepetitions: required,
        sampleCount: measurements.length,
        citations: unique(measurements.flatMap((item) => item.citations)),
        detail:
          `scenario "${scenario}" repetition ${failing.repetition} failed the categorical bar` +
          `${failing.detail ? ` — ${failing.detail}` : ""}`,
      };
    }
  }
  return null;
}

/**
 * Judge one property. `evidence` is `undefined` when no evaluator owns the
 * property; that is a failure, never a skip. An unresolved property fails even
 * if an evaluator somehow measured it.
 */
export function judgeProperty(
  property: ContractPropertyEntry,
  evidence: PropertyEvidence | undefined,
): PropertyVerdict {
  if (property.unresolved !== undefined) {
    return failed(
      property,
      "unresolved",
      `${property.id}: unresolved — ${property.unresolved.reason}`,
    );
  }
  if (evidence === undefined) {
    return failed(
      property,
      "no-evaluator",
      `${property.id}: no evaluator declared for this property; an unmeasured property fails`,
    );
  }

  const problem = barProblem(property, evidence.bars);
  if (problem !== null) {
    return failed(property, "bar-unbound", `${property.id}: ${problem}`);
  }

  const seen = new Set<string>();
  for (const measurement of evidence.measurements) {
    const key = `${measurement.scenario}#${measurement.repetition}`;
    if (seen.has(key)) {
      return failed(
        property,
        "duplicate-repetition",
        `${property.id}: scenario "${measurement.scenario}" repetition ${measurement.repetition} ` +
          "is recorded twice; a retry cannot replace a failure",
      );
    }
    seen.add(key);
  }

  const byScenario = new Map<
    string,
    { measurements: PropertyMeasurement[]; samples: number[]; locale?: string }
  >();
  for (const measurement of evidence.measurements) {
    const current = byScenario.get(measurement.scenario);
    if (current === undefined) {
      byScenario.set(measurement.scenario, {
        measurements: [measurement],
        samples: [...measurement.samples],
        ...(measurement.locale === undefined ? {} : { locale: measurement.locale }),
      });
    } else {
      current.measurements.push(measurement);
      current.samples.push(...measurement.samples);
    }
  }

  if (evidence.measurements.length === 0) {
    return failed(
      property,
      "unmeasured",
      `${property.id}: no scenario measured this property; an unmeasured property fails`,
    );
  }

  // The repetition plan. Only the declared repetitions are judged, and every
  // one of them must be present; a timing/behaviour property without its three
  // repetitions has no verdict.
  const selected: PropertyMeasurement[] = [];
  const missingByScenario: string[] = [];
  for (const [scenario, entry] of byScenario) {
    const plan = plannedMeasurements(property, entry.measurements);
    selected.push(...plan.selected);
    if (plan.missing.length > 0) {
      missingByScenario.push(
        `scenario "${scenario}" measured ${plan.selected.length} of ${property.repetitions} ` +
          `declared repetitions (missing ${plan.missing.join(", ")})`,
      );
    }
    entry.measurements = plan.selected;
    entry.samples = plan.selected.flatMap((item) => item.samples);
  }
  if (missingByScenario.length > 0) {
    return {
      ...baseVerdict(property),
      status: "FAIL",
      reason: "repetition-shortfall",
      detail: `${property.id}: ${missingByScenario.join("; ")}`,
      sampleCount: selected.reduce((sum, item) => sum + item.samples.length, 0),
      citations: unique(selected.flatMap((item) => item.citations)),
    };
  }

  const scenarioVerdicts: ScenarioVerdict[] = [];
  for (const [scenario, entry] of byScenario) {
    const failure = scenarioFailure(
      scenario,
      entry.locale,
      entry.measurements,
      property.repetitions,
      property.bar.numeric,
    );
    if (failure !== null) {
      scenarioVerdicts.push(failure);
      continue;
    }
    scenarioVerdicts.push({
      scenario,
      ...(entry.locale === undefined ? {} : { locale: entry.locale }),
      status: "PASS",
      reason: "pass",
      measuredRepetitions: entry.measurements.length,
      requiredRepetitions: property.repetitions,
      sampleCount: entry.samples.length,
      citations: unique(entry.measurements.flatMap((item) => item.citations)),
      detail: `${property.id}: scenario "${scenario}" measured ${entry.measurements.length} of ${property.repetitions} repetitions`,
    });
  }

  const outcomeFailure = scenarioVerdicts.find((scenario) => scenario.status === "FAIL");
  if (outcomeFailure !== undefined) {
    return {
      ...baseVerdict(property),
      status: "FAIL",
      reason: outcomeFailure.reason,
      detail: outcomeFailure.detail,
      sampleCount: selected.reduce((sum, item) => sum + item.samples.length, 0),
      scenarios: scenarioVerdicts,
      citations: unique(selected.flatMap((item) => item.citations)),
    };
  }

  const citations = unique(selected.flatMap((item) => item.citations));

  if (!property.bar.numeric) {
    const missingVerdict = selected.find((item) => typeof item.passed !== "boolean");
    if (missingVerdict !== undefined) {
      return {
        ...baseVerdict(property),
        status: "FAIL",
        reason: "categorical-missing-verdict",
        detail:
          `${property.id}: scenario "${missingVerdict.scenario}" repetition ` +
          `${missingVerdict.repetition} carries no pass/fail verdict for a categorical bar`,
        sampleCount: selected.length,
        scenarios: scenarioVerdicts,
        citations,
      };
    }
    const failing = selected.filter((item) => item.passed === false);
    if (failing.length > 0) {
      const first = failing[0];
      return {
        ...baseVerdict(property),
        status: "FAIL",
        reason: "below-bar",
        detail:
          `${property.id}: categorical bar failed in scenario "${first.scenario}" ` +
          `repetition ${first.repetition}${first.detail ? ` — ${first.detail}` : ""}`,
        sampleCount: selected.length,
        scenarios: scenarioVerdicts,
        citations,
      };
    }
    return {
      ...baseVerdict(property),
      status: "PASS",
      reason: "pass",
      detail:
        `${property.id}: PASS — ${selected.length} judged attempt${selected.length === 1 ? "" : "s"} ` +
        `across ${byScenario.size} scenario${byScenario.size === 1 ? "" : "s"}`,
      sampleCount: selected.length,
      scenarios: scenarioVerdicts,
      citations,
    };
  }

  const invalid = selected.find((item) => item.samples.some((sample) => !Number.isFinite(sample)));
  if (invalid !== undefined) {
    return {
      ...baseVerdict(property),
      status: "FAIL",
      reason: "invalid-sample",
      detail:
        `${property.id}: scenario "${invalid.scenario}" repetition ${invalid.repetition} ` +
        "measured a non-finite sample",
      scenarios: scenarioVerdicts,
      citations,
    };
  }

  const samples = selected.flatMap((item) => item.samples);
  const empty = selected.find((item) => item.samples.length === 0);
  if (empty !== undefined) {
    return {
      ...baseVerdict(property),
      status: "FAIL",
      reason: "empty-sample",
      detail:
        `${property.id}: scenario "${empty.scenario}" repetition ${empty.repetition} ` +
        "measured no samples",
      scenarios: scenarioVerdicts,
      citations,
    };
  }

  const summary = summarizeSamples(samples);
  if (summary === null) {
    return {
      ...baseVerdict(property),
      status: "FAIL",
      reason: "empty-sample",
      detail: `${property.id}: no samples to judge`,
      scenarios: scenarioVerdicts,
      citations,
    };
  }

  const { checks, smallSample, notes } = numericChecks(
    property,
    evidence.bars,
    summary,
    byScenario,
  );

  // Attribute each tail failure to its scenario so the property verdict names it.
  const checksByScenario = new Map<string, ThresholdCheck[]>();
  for (const item of checks) {
    if (item.scenario === null) continue;
    const list = checksByScenario.get(item.scenario) ?? [];
    list.push(item);
    checksByScenario.set(item.scenario, list);
  }
  const finalScenarios = scenarioVerdicts.map((scenario) => {
    const failedCheck = (checksByScenario.get(scenario.scenario) ?? []).find(
      (item) => !item.passed,
    );
    if (failedCheck === undefined) return scenario;
    return {
      ...scenario,
      status: "FAIL" as PropertyStatus,
      reason: "below-bar" as PropertyVerdictReason,
      detail: `${scenario.scenario}: ${failedCheck.detail}`,
    };
  });

  const failing = checks.filter((item) => !item.passed);
  if (failing.length > 0) {
    return {
      ...baseVerdict(property),
      status: "FAIL",
      reason: "below-bar",
      detail:
        `${property.id}: ${failing.map((item) => item.detail).join("; ")} ` +
        `(n=${summary.count})`,
      sampleCount: summary.count,
      smallSample,
      summary,
      scenarios: finalScenarios,
      checks,
      citations,
    };
  }

  const tails = finalScenarios.length;
  return {
    ...baseVerdict(property),
    status: "PASS",
    reason: "pass",
    detail:
      `${property.id}: PASS — ${summary.count} samples across ${byScenario.size} ` +
      `scenario${byScenario.size === 1 ? "" : "s"} (${tails} tail` +
      `${tails === 1 ? "" : "s"} checked); ` +
      (notes.length === 0
        ? `${checks.map((item) => item.detail).join("; ")}`
        : `${checks.map((item) => item.detail).join("; ")}; ${notes.join("; ")}`),
    sampleCount: summary.count,
    smallSample,
    summary,
    scenarios: finalScenarios,
    checks,
    citations,
  };
}

// ── The run ─────────────────────────────────────────────────────────────────

function judgeEligibility(
  calls: readonly CallEligibilityFact[],
): RunEligibilityVerdict {
  const reasons: string[] = [];
  for (const call of calls) {
    if (
      typeof call.providerFallback === "string" &&
      call.providerFallback.trim() !== ""
    ) {
      reasons.push(
        `call "${call.callId}" (scenario "${call.scenario}") recorded a provider fallback ` +
          `at "${call.providerFallback.trim()}"; a fallback-contaminated run is ineligible`,
      );
    }
    if (typeof call.budgetStop === "string" && call.budgetStop.trim() !== "") {
      reasons.push(
        `call "${call.callId}" (scenario "${call.scenario}") hit a budget stop ` +
          `("${call.budgetStop.trim()}"); a budget-stopped run is ineligible`,
      );
    }
  }
  return { eligible: reasons.length === 0, reasons, callCount: calls.length };
}

/**
 * Judge a whole run against the loaded contract. Every contract property
 * appears in the result — including one no evaluator measured, which fails. An
 * ineligible run is reported as `ineligible` and is never certifiable, whatever
 * its properties say.
 */
export function judgeRun(input: RunInput): RunVerdict {
  const contract: Contract = input.contract;
  const known = new Map(contract.properties.map((property) => [property.id, property]));

  const failures: string[] = [];
  const unknownPropertyIds: string[] = [];
  const byProperty = new Map<string, PropertyEvidence>();
  for (const evidence of input.evidence) {
    if (!known.has(evidence.propertyId)) {
      unknownPropertyIds.push(evidence.propertyId);
      failures.push(
        `evidence names unknown property "${evidence.propertyId}"; the contract does not know it`,
      );
      continue;
    }
    if (byProperty.has(evidence.propertyId)) {
      failures.push(
        `property "${evidence.propertyId}" has two evidence sets; one property has one owner`,
      );
      continue;
    }
    byProperty.set(evidence.propertyId, evidence);
  }

  const properties = contract.properties.map((property) =>
    judgeProperty(property, byProperty.get(property.id)),
  );
  const failedProperties = properties.filter((property) => property.status === "FAIL");
  const eligibility = judgeEligibility(input.calls ?? []);

  let verdict: RunVerdictValue;
  if (!eligibility.eligible) verdict = "ineligible";
  else if (failedProperties.length > 0 || failures.length > 0) verdict = "not-demo-ready";
  else verdict = "certified";

  const certifiable = verdict === "certified";
  const sampleCount = properties.reduce((sum, property) => sum + property.sampleCount, 0);
  const citations = unique(properties.flatMap((property) => property.citations));
  const detail =
    verdict === "ineligible"
      ? `ineligible: ${eligibility.reasons.join("; ")}`
      : verdict === "certified"
        ? `certified: ${properties.length}/${properties.length} properties pass ` +
          `(${sampleCount} samples, ${eligibility.callCount} calls)`
        : `not-demo-ready: ${failedProperties.length} of ${properties.length} properties failed` +
          `${failedProperties.length === 0 ? "" : ` (${failedProperties.map((property) => property.propertyId).join(", ")})`}` +
          `${failures.length === 0 ? "" : `; ${failures.join("; ")}`}`;

  return {
    runId: input.runId,
    verdict,
    certifiable,
    eligible: eligibility.eligible,
    eligibility,
    properties,
    failedPropertyIds: failedProperties.map((property) => property.propertyId),
    unknownPropertyIds,
    failures,
    sampleCount,
    citations,
    detail,
  };
}
