/**
 * Judging a fast, nightly or full run with its own ceiling.
 *
 * The verdict engine judges one property from scenario measurements, but E3 is
 * a run property: its sample is the run's total, and its bar is the one ceiling
 * the plan names. This composition replaces the per-call E3 evidence with the
 * run gate's own, narrows the contract to that ceiling, judges, and then drops
 * E3's synthetic scenario row — E3 was never a corpus scenario, and a
 * certificate must not report it as one.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Economics" E3.
 */

import type { Contract } from "../contract";
import {
  judgeRun,
  type CallEligibilityFact,
  type PropertyEvidence,
  type RunVerdict,
} from "../verdict";
import {
  scopeRunToCeiling,
  type RunCeilingCheck,
  type RunCostRow,
  type RunKind,
} from "./run-ceiling";

export function judgeRunWithCeiling(input: {
  readonly runId: string;
  readonly contract: Contract;
  readonly evidence: readonly PropertyEvidence[];
  readonly kind: RunKind;
  readonly calls: readonly RunCostRow[];
  /** Every call's fallback/budget fact; a budget stop makes the run ineligible. */
  readonly callFacts?: readonly CallEligibilityFact[];
}): { verdict: RunVerdict; check: RunCeilingCheck } {
  const scoped = scopeRunToCeiling({
    contract: input.contract,
    evidence: input.evidence,
    kind: input.kind,
    calls: input.calls,
  });
  const verdict = judgeRun({
    runId: input.runId,
    contract: scoped.contract,
    evidence: scoped.evidence,
    ...(input.callFacts === undefined ? {} : { calls: input.callFacts }),
  });
  return {
    verdict: {
      ...verdict,
      properties: verdict.properties.map((property) =>
        property.propertyId === "E3" ? { ...property, scenarios: [] } : property,
      ),
    },
    check: scoped.check,
  };
}
