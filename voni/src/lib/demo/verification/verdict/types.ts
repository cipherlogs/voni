/**
 * The verdict core's vocabulary: what an evaluator measures, what the engine
 * judges, and what a certificate may read.
 *
 * One property is judged from measurements an evaluator produced from a
 * scenario's evidence. The evaluator binds each of the property's frozen
 * threshold keys to a statistic and a comparison; the engine owns the pooling,
 * the per-scenario tail, the sample floors and the fail-closed outcomes. No
 * evaluator may supply a bar number: it names a key the contract already
 * resolved.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Statistics and the pass rule".
 */

import type {
  Contract,
  ContractPropertyEntry,
  EvidenceSource,
  FamilyId,
  PropertyKind,
  ThresholdSource,
} from "../contract";
import type { ScenarioFacts } from "../scenarios";
import type { Comparison, SampleSummary, Statistic } from "./statistics";

/**
 * One frozen threshold key, bound to the statistic that judges it and the
 * direction of the bar. The evaluator declares the mapping because it knows
 * what its samples mean; the number still comes from the contract.
 */
export type BarBinding = {
  readonly key: string;
  readonly statistic: Statistic;
  readonly comparison: Comparison;
  /**
   * Which value in a measurement's `samples` tuple this bar judges. Absent
   * means every sample is the same metric (the timing/behaviour shape). A
   * multi-axis property — timbre's six axes, playout's underrun and overrun —
   * returns one value per axis and names its index here, so a bar is never
   * judged against a value in another unit. An index the measurement does not
   * carry is an empty sample and fails closed.
   */
  readonly sample?: number;
};

/** One evidence source's payload. Each evaluator family documents its shape. */
export type EvidenceBundle = Partial<Record<EvidenceSource, unknown>>;

/** One scenario attempt: one call's evidence at one repetition. */
export type ScenarioAttempt = {
  readonly scenario: string;
  /** 1-based repetition index. Deterministic properties use 1. */
  readonly repetition: number;
  readonly locale?: string;
  readonly target?: string;
  /** A missing source is a failure for the property that reads it. */
  readonly evidence: EvidenceBundle;
  /**
   * The scenario's authored caller words in script order. Ground truth, not a
   * measurement: an exactness bar compares measured output to it.
   */
  readonly facts?: ScenarioFacts;
};

/** What an evaluator is handed for one property in one scenario attempt. */
export type EvaluatorContext = {
  readonly property: ContractPropertyEntry;
  readonly scenario: string;
  readonly locale?: string;
  readonly target?: string;
  readonly repetition: number;
  /** The one source this property reads; the engine checked it exists. */
  readonly source: unknown;
  /** Every source, when an evaluator cross-checks two. */
  readonly evidence: EvidenceBundle;
  /** The scenario's authored caller words, when the adapter supplied them. */
  readonly facts?: ScenarioFacts;
};

/**
 * What one evaluator observed. `measured` carries the raw samples, or a
 * categorical verdict for a bar with no number. Everything else is a failure:
 * unmeasured, skipped and errored evidence can never be a pass.
 */
export type Evaluation =
  | {
      readonly kind: "measured";
      /** Raw values the engine pools; empty is an empty sample and fails. */
      readonly samples?: readonly number[];
      /** Required for a categorical bar (`numeric: false`), ignored otherwise. */
      readonly passed?: boolean;
      readonly citations?: readonly string[];
      readonly detail?: string;
    }
  | {
      readonly kind: "unmeasured" | "skipped" | "error";
      readonly reason: string;
      readonly citations?: readonly string[];
    };

/** One property's evaluator, discovered by family. */
export type PropertyEvaluator = {
  /** The contract id this evaluator judges; one evaluator per id. */
  readonly propertyId: string;
  /** One binding per threshold key of the property. */
  readonly bars: readonly BarBinding[];
  /** Where the evaluator came from, for a refusal that names it. */
  readonly source?: string;
  evaluate(context: EvaluatorContext): Evaluation | Promise<Evaluation>;
};

/** One family module in `verdict/evaluators/`; discovered at load. */
export type EvaluatorModule = {
  readonly family: FamilyId;
  readonly evaluators: readonly PropertyEvaluator[];
};

/** How one attempt's evaluation ended. Only `measured` can pass. */
export const MEASUREMENT_OUTCOMES = [
  "measured",
  "unmeasured",
  "skipped",
  "error",
  "missing-evidence",
] as const;

export type MeasurementOutcome = (typeof MEASUREMENT_OUTCOMES)[number];

/** One evaluator's verdict for one property in one scenario attempt. */
export type PropertyMeasurement = {
  readonly propertyId: string;
  readonly scenario: string;
  readonly repetition: number;
  readonly locale?: string;
  readonly outcome: MeasurementOutcome;
  readonly samples: readonly number[];
  readonly passed?: boolean;
  readonly reason?: string;
  readonly citations: readonly string[];
  readonly detail?: string;
};

/**
 * Everything one evaluator produced for one property. `bars` travel with the
 * evidence so the judgement is self-contained and testable without a registry.
 */
export type PropertyEvidence = {
  readonly propertyId: string;
  readonly bars: readonly BarBinding[];
  readonly measurements: readonly PropertyMeasurement[];
};

/**
 * One call's eligibility facts. A named fallback on any leg at any phase, or a
 * budget stop, makes the whole run ineligible — never a pass with a footnote.
 */
export type CallEligibilityFact = {
  readonly callId: string;
  readonly scenario: string;
  /** Where the fallback happened, e.g. "stt at connect". Empty means none. */
  readonly providerFallback?: string | null;
  /** The budget stop's name, e.g. "nightly ceiling". Empty means none. */
  readonly budgetStop?: string | null;
};

/** What `judgeRun` reads. `contract` supplies every property, measured or not. */
export type RunInput = {
  readonly runId: string;
  readonly contract: Contract;
  readonly evidence: readonly PropertyEvidence[];
  readonly calls?: readonly CallEligibilityFact[];
};

export type PropertyStatus = "PASS" | "FAIL";

/** Why a property has the status it has. Every non-pass reason is a failure. */
export type PropertyVerdictReason =
  | "pass"
  | "below-bar"
  | "unresolved"
  | "no-evaluator"
  | "unmeasured"
  | "skipped"
  | "evaluator-error"
  | "missing-evidence"
  | "empty-sample"
  | "invalid-sample"
  | "repetition-shortfall"
  | "duplicate-repetition"
  | "bar-unbound"
  | "categorical-missing-verdict";

/** One bar the engine checked. `scenario: null` means the pooled scope. */
export type ThresholdCheck = {
  readonly key: string;
  readonly source: ThresholdSource;
  /** The statistic actually compared. A small sample compares the tail. */
  readonly statistic: Statistic;
  readonly comparison: Comparison;
  readonly budget: number;
  readonly unit: string;
  readonly observed: number;
  /** The scenario whose tail this is; null for a pooled check. */
  readonly scenario: string | null;
  readonly locale?: string;
  readonly passed: boolean;
  readonly detail: string;
  /** Set when the check is not the declared statistic (small-sample tail). */
  readonly note?: string;
};

/** One scenario's contribution to a property's verdict. */
export type ScenarioVerdict = {
  readonly scenario: string;
  readonly locale?: string;
  readonly status: PropertyStatus;
  readonly reason: PropertyVerdictReason;
  /** Attempts judged for this scenario, after the repetition plan. */
  readonly measuredRepetitions: number;
  readonly requiredRepetitions: number;
  readonly sampleCount: number;
  readonly citations: readonly string[];
  readonly detail: string;
};

/** One property's verdict, with the sample count and citations 08 and 09 need. */
export type PropertyVerdict = {
  readonly propertyId: string;
  readonly family: FamilyId;
  readonly statement: string;
  readonly bar: string;
  readonly barNumeric: boolean;
  readonly kind: PropertyKind;
  readonly evidence: EvidenceSource;
  readonly status: PropertyStatus;
  readonly reason: PropertyVerdictReason;
  readonly detail: string;
  /** Pooled samples for a numeric bar; judged attempts for a categorical one. */
  readonly sampleCount: number;
  /** The declared repetition count the sample plan required. */
  readonly requiredRepetitions: number;
  /** True when the pooled median was not judged (fewer than the floor). */
  readonly smallSample: boolean;
  readonly summary: SampleSummary | null;
  readonly scenarios: readonly ScenarioVerdict[];
  readonly checks: readonly ThresholdCheck[];
  readonly citations: readonly string[];
  /** Recorded gaps that weaken the property; they never turn it green. */
  readonly gaps: readonly string[];
};

/** Only `certified` may be called a pass. */
export const RUN_VERDICTS = ["certified", "not-demo-ready", "ineligible"] as const;

export type RunVerdictValue = (typeof RUN_VERDICTS)[number];

export type RunEligibilityVerdict = {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly callCount: number;
};

/** The run-level verdict the certificate builder reads. */
export type RunVerdict = {
  readonly runId: string;
  readonly verdict: RunVerdictValue;
  /** True only when eligible and every property passed. */
  readonly certifiable: boolean;
  readonly eligible: boolean;
  readonly eligibility: RunEligibilityVerdict;
  readonly properties: readonly PropertyVerdict[];
  readonly failedPropertyIds: readonly string[];
  /** Evidence for ids the contract does not know; any entry fails the run. */
  readonly unknownPropertyIds: readonly string[];
  /** Structural failures: duplicate evidence, unknown ids, retry attempts. */
  readonly failures: readonly string[];
  readonly sampleCount: number;
  readonly citations: readonly string[];
  readonly detail: string;
};

/** What evaluator discovery and `evaluateScenarios` read. */
export type EvaluateScenariosInput = {
  readonly contract: Contract;
  readonly evaluators: readonly PropertyEvaluator[];
  readonly attempts: readonly ScenarioAttempt[];
};
