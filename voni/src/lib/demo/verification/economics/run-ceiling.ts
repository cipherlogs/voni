/**
 * Run ceilings: the contract's own money bounds for a fast, nightly or full
 * run. A run is checked twice — against the worst-case plan before the first
 * call, and against the calls' own priced rows when it ends. The harness never
 * recomputes a call's price and never presents a partial sum as a total: one
 * unmeasured call leaves the run unmeasured, which fails.
 *
 * E3's three bars are alternative ceilings, one per run kind. A run is judged
 * against the ceiling its plan names, so {@link contractForRunCeiling} narrows
 * the registry view to that one key and {@link runCeilingEvidence} binds it.
 * The other two ceilings are not applicable to that run and are never guessed.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Economics" E3.
 */

import type { Contract, ResolvedThreshold } from "../contract";
import type { Evaluation, PropertyEvidence, PropertyMeasurement } from "../verdict";
import { readPricedRow } from "./priced-cost";

export const RUN_KINDS = ["fast", "nightly", "full"] as const;

export type RunKind = (typeof RUN_KINDS)[number];

/** The threshold key each run kind is judged against. */
export const RUN_CEILING_KEYS: Readonly<Record<RunKind, string>> = {
  fast: "dvCostFastRunMaxUsd",
  nightly: "dvCostNightlyRunMaxUsd",
  full: "dvCostFullRunMaxUsd",
};

/** E2's key: the per-call ceiling the pre-run projection multiplies. */
export const PER_CALL_CEILING_KEY = "dvCostPerCallMaxUsd";

/** The synthetic scenario name E3's run-scoped measurement carries. */
export const RUN_SCENARIO = "@run";

export const RUN_CEILING_ERROR_CODES = [
  "unknown-run-kind",
  "invalid-plan",
  "missing-ceiling",
  "not-settled",
] as const;

export type RunCeilingErrorCode = (typeof RUN_CEILING_ERROR_CODES)[number];

export class RunCeilingError extends Error {
  readonly code: RunCeilingErrorCode;

  constructor(code: RunCeilingErrorCode, message: string) {
    super(message);
    this.name = "RunCeilingError";
    this.code = code;
  }
}

/** One call's cost evidence: its own priced row, copied from its trace. */
export type RunCostRow = {
  readonly callId: string;
  readonly scenario: string;
  /** The `cost.priced` row. Missing means the call has no measured cost. */
  readonly cost?: unknown;
};

/** What a ceiling check found. `usd` is projected (before) or spent (end). */
export type RunCeilingCheck = {
  readonly phase: "before" | "end";
  readonly kind: RunKind;
  readonly key: string;
  readonly ceilingUsd: number;
  readonly calls: number;
  readonly callIds: readonly string[];
  readonly usd: number | null;
  /** Calls whose priced row is missing or unmeasured. Empty when all measured. */
  readonly unmeasuredCalls: readonly string[];
  readonly passed: boolean;
  readonly detail: string;
};

/** The run-scoped cost source E3 reads; never a per-call row. */
export type RunCostSource = {
  readonly run: {
    readonly kind: RunKind;
    readonly totalUsd: number | null;
    readonly calls: number;
    readonly callIds: readonly string[];
    readonly unmeasuredCalls: readonly string[];
  };
};

function kindOf(kind: unknown): RunKind {
  if (!(RUN_KINDS as readonly unknown[]).includes(kind)) {
    throw new RunCeilingError(
      "unknown-run-kind",
      `"${String(kind)}" is not a run kind; known: ${RUN_KINDS.join(", ")}`,
    );
  }
  return kind as RunKind;
}

function thresholdOf(
  contract: Contract,
  propertyId: string,
  key: string,
  what: string,
): ResolvedThreshold {
  const property = contract.properties.find((entry) => entry.id === propertyId);
  const threshold = property?.thresholds.find((entry) => entry.key === key);
  if (threshold === undefined) {
    throw new RunCeilingError(
      "missing-ceiling",
      `the contract has no ${what} at ${propertyId}.${key}; a run cannot be bounded by a number it does not have`,
    );
  }
  if (threshold.unit !== "usd") {
    throw new RunCeilingError(
      "missing-ceiling",
      `${propertyId}.${key} is measured in "${threshold.unit}", not usd; a ceiling must match the priced rows`,
    );
  }
  return threshold;
}

/** Resolve the one ceiling a run of `kind` owes, from E3's frozen bars. */
export function runCeilingFor(contract: Contract, kind: RunKind): ResolvedThreshold {
  return thresholdOf(contract, "E3", RUN_CEILING_KEYS[kindOf(kind)], `${kind} run ceiling`);
}

function usd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

/**
 * The pre-run check: the worst case the plan can spend, `plannedCalls` times
 * the frozen per-call ceiling. A plan that cannot fit its run ceiling is
 * refused before a vendor is opened.
 */
export function preflightRunCeiling(input: {
  readonly kind: RunKind;
  readonly contract: Contract;
  readonly plannedCalls: number;
}): RunCeilingCheck {
  const kind = kindOf(input.kind);
  if (!Number.isInteger(input.plannedCalls) || input.plannedCalls <= 0) {
    throw new RunCeilingError(
      "invalid-plan",
      `a ${kind} run plans a positive whole number of calls, got ${String(input.plannedCalls)}`,
    );
  }
  const ceiling = runCeilingFor(input.contract, kind);
  const perCall = thresholdOf(
    input.contract,
    "E2",
    PER_CALL_CEILING_KEY,
    "per-call ceiling",
  );
  const projected = input.plannedCalls * perCall.value;
  const passed = projected <= ceiling.value;
  return {
    phase: "before",
    kind,
    key: ceiling.key,
    ceilingUsd: ceiling.value,
    calls: input.plannedCalls,
    callIds: [],
    usd: projected,
    unmeasuredCalls: [],
    passed,
    detail:
      `${kind} run: ${input.plannedCalls} planned calls x ${usd(perCall.value)} per-call ceiling ` +
      `= ${usd(projected)} ${passed ? "<=" : ">"} ${usd(ceiling.value)} run ceiling`,
  };
}

/**
 * The end check: sum the calls' own `totalUsd`, verbatim. A missing or
 * unmeasured priced row leaves the run with no total; the check fails and
 * names the calls rather than summing the rest.
 */
export function settleRunCeiling(input: {
  readonly kind: RunKind;
  readonly contract: Contract;
  readonly calls: readonly RunCostRow[];
}): RunCeilingCheck {
  const kind = kindOf(input.kind);
  const ceiling = runCeilingFor(input.contract, kind);
  const unmeasured: { callId: string; reason: string }[] = [];
  let spent = 0;
  for (const call of input.calls) {
    try {
      if (call.cost === undefined || call.cost === null) {
        throw new Error("the trace carries no cost.priced row");
      }
      const priced = readPricedRow(call.cost);
      if (!priced.measured || priced.totalUsd === null) {
        unmeasured.push({
          callId: call.callId,
          reason: priced.unmeasuredReason ?? "unmeasured",
        });
        continue;
      }
      spent += priced.totalUsd;
    } catch (error) {
      unmeasured.push({
        callId: call.callId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const callIds = input.calls.map((call) => call.callId);
  if (unmeasured.length > 0 || input.calls.length === 0) {
    const reasons =
      unmeasured.length > 0
        ? `unmeasured: ${unmeasured
            .map((entry) => `${entry.callId} (${entry.reason})`)
            .join(", ")}`
        : "no calls were recorded";
    return {
      phase: "end",
      kind,
      key: ceiling.key,
      ceilingUsd: ceiling.value,
      calls: input.calls.length,
      callIds,
      usd: null,
      unmeasuredCalls: unmeasured.map((entry) => entry.callId),
      passed: false,
      detail:
        `${kind} run: cost is unmeasured; a run with an unmeasured call has no total ` +
        `(${reasons}); the ${usd(ceiling.value)} ceiling is not judged`,
    };
  }
  const passed = spent <= ceiling.value;
  return {
    phase: "end",
    kind,
    key: ceiling.key,
    ceilingUsd: ceiling.value,
    calls: input.calls.length,
    callIds,
    usd: spent,
    unmeasuredCalls: [],
    passed,
    detail:
      `${kind} run: ${usd(spent)} across ${input.calls.length} calls ` +
      `${passed ? "<=" : ">"} ${usd(ceiling.value)} run ceiling`,
  };
}

/** The run-scoped source E3's evaluator reads; only a settled check has one. */
export function runCostSource(check: RunCeilingCheck): RunCostSource {
  if (check.phase !== "end") {
    throw new RunCeilingError(
      "not-settled",
      `a ${check.kind} run's cost is not known before it ends; ` +
        "only the settled check carries a total",
    );
  }
  return {
    run: {
      kind: check.kind,
      totalUsd: check.usd,
      calls: check.calls,
      callIds: check.callIds,
      unmeasuredCalls: check.unmeasuredCalls,
    },
  };
}

function isRunSource(source: unknown): source is RunCostSource {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return false;
  const run = (source as Record<string, unknown>).run;
  return typeof run === "object" && run !== null && !Array.isArray(run);
}

/**
 * E3's evaluation. A run-scoped source is measured from the run's own total;
 * a per-call priced row has no run total and is reported unmeasured, never
 * judged as if one call were the whole run.
 */
export function evaluateRunCost(source: unknown): Evaluation {
  if (!isRunSource(source)) {
    return {
      kind: "unmeasured",
      reason:
        "E3 judges a run's total cost; this attempt is one call and carries no run total. " +
        "Run ceilings are judged by scopeRunToCeiling at the end of a fast, nightly or full run",
      citations: [],
    };
  }
  const run = source.run as Record<string, unknown>;
  const kind = run.kind;
  if (!(RUN_KINDS as readonly unknown[]).includes(kind)) {
    return {
      kind: "unmeasured",
      reason: `the run cost source names unknown run kind "${String(kind)}"`,
      citations: [],
    };
  }
  const calls = run.calls;
  if (!Number.isInteger(calls) || (calls as number) <= 0) {
    return {
      kind: "unmeasured",
      reason: `the run cost source carries no positive call count (${String(calls)})`,
      citations: [],
    };
  }
  const unmeasured = Array.isArray(run.unmeasuredCalls)
    ? run.unmeasuredCalls.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (unmeasured.length > 0) {
    return {
      kind: "unmeasured",
      reason: `the ${String(kind)} run has unmeasured calls: ${unmeasured.join(", ")}`,
      citations: unmeasured.map((callId) => `cost:${callId}`),
    };
  }
  const total = run.totalUsd;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return {
      kind: "unmeasured",
      reason: "the run cost source carries no measured total; a partial sum is not a cost",
      citations: [],
    };
  }
  const callIds = Array.isArray(run.callIds)
    ? run.callIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    kind: "measured",
    samples: [total],
    citations: callIds.map((callId) => `cost:${callId}`),
    detail: `${String(kind)} run spent $${total.toFixed(6)} across ${String(calls)} calls`,
  };
}

/**
 * E3's evidence for a settled run: one measurement from the run's own total,
 * bound to the one ceiling that applies to its kind.
 */
export function runCeilingEvidence(check: RunCeilingCheck): PropertyEvidence {
  const evaluation = evaluateRunCost(runCostSource(check));
  let measurement: PropertyMeasurement;
  if (evaluation.kind === "measured") {
    measurement = {
      propertyId: "E3",
      scenario: RUN_SCENARIO,
      repetition: 1,
      outcome: "measured",
      samples: [...(evaluation.samples ?? [])],
      ...(evaluation.detail === undefined ? {} : { detail: evaluation.detail }),
      citations: [...(evaluation.citations ?? [])],
    };
  } else {
    measurement = {
      propertyId: "E3",
      scenario: RUN_SCENARIO,
      repetition: 1,
      outcome: evaluation.kind,
      samples: [],
      reason: evaluation.reason,
      citations: [...(evaluation.citations ?? [])],
    };
  }
  return {
    propertyId: "E3",
    bars: [{ key: check.key, statistic: "each", comparison: "at-most" }],
    measurements: [measurement],
  };
}

/**
 * The contract as one run reads it: E3 keeps only the ceiling its kind owes.
 * Every other property is untouched, so a run-kind scope cannot weaken or move
 * a bar that is not about run cost.
 */
export function contractForRunCeiling(contract: Contract, kind: RunKind): Contract {
  const key = runCeilingFor(contract, kind).key;
  return {
    families: contract.families,
    properties: contract.properties.map((property) =>
      property.id === "E3"
        ? {
            ...property,
            thresholds: property.thresholds.filter((threshold) => threshold.key === key),
          }
        : property,
    ),
  };
}

/**
 * Replace the per-call E3 evidence with the run's own, then narrow the contract
 * to the applicable ceiling. A caller judges the result with `judgeRun`.
 *
 * E3 is the one property whose bar is chosen by the run plan, so a per-call
 * attempt cannot judge it. The replacement is explicit, not a silent merge.
 */
export function scopeRunToCeiling(input: {
  readonly contract: Contract;
  readonly evidence: readonly PropertyEvidence[];
  readonly kind: RunKind;
  readonly calls: readonly RunCostRow[];
}): { contract: Contract; evidence: PropertyEvidence[]; check: RunCeilingCheck } {
  const check = settleRunCeiling({
    kind: input.kind,
    contract: input.contract,
    calls: input.calls,
  });
  return {
    contract: contractForRunCeiling(input.contract, input.kind),
    evidence: [
      ...input.evidence.filter((entry) => entry.propertyId !== "E3"),
      runCeilingEvidence(check),
    ],
    check,
  };
}
