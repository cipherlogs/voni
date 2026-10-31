/**
 * Verdict and statistics: one engine turns property evidence into a verdict.
 *
 * Read `docs/agents/demo-verification.md` for the subsystem map and ADR 0013
 * for the decisions this core enforces.
 */

export {
  COMPARISONS,
  MIN_SAMPLES_FOR_P50,
  SMALL_SAMPLE_FLOOR,
  STATISTICS,
  compareToBudget,
  comparisonSymbol,
  statisticValue,
  summarizeSamples,
  type Comparison,
  type SampleSummary,
  type Statistic,
} from "./statistics";

export { VerdictError, type VerdictErrorCode } from "./errors";

export {
  EVALUATORS_DIR,
  buildEvaluatorRegistry,
  evaluateScenarios,
  loadEvaluatorModules,
  loadEvaluators,
  type DiscoveredEvaluatorModule,
} from "./evaluators";

export { judgeProperty, judgeRun } from "./judge";

export {
  MEASUREMENT_OUTCOMES,
  RUN_VERDICTS,
  type BarBinding,
  type CallEligibilityFact,
  type EvaluateScenariosInput,
  type EvaluatorContext,
  type EvaluatorModule,
  type Evaluation,
  type EvidenceBundle,
  type MeasurementOutcome,
  type PropertyEvaluator,
  type PropertyEvidence,
  type PropertyMeasurement,
  type PropertyStatus,
  type PropertyVerdict,
  type PropertyVerdictReason,
  type RunEligibilityVerdict,
  type RunInput,
  type RunVerdict,
  type RunVerdictValue,
  type ScenarioAttempt,
  type ScenarioVerdict,
  type ThresholdCheck,
} from "./types";
