/**
 * The demo-verification scenario runtime: one scenario record both adapters
 * read.
 *
 * Read `docs/agents/demo-verification.md` for the subsystem map and ADR 0013
 * for the one-seam decision this package must not violate.
 */

export {
  SCENARIO_SCHEMA_VERSION,
  CORPUS_SCHEMA_VERSION,
  SCENARIO_FILE,
  CORPUS_MANIFEST_FILE,
  SCENARIO_CLASSES,
  LOCALES,
  HELD_OUT_SCENARIOS,
  TRIGGER_TYPES,
  AGENT_EVENT_TYPES,
  FAULT_KINDS,
  EDGE_CONDITION_KINDS,
  type ScenarioClass,
  type Locale,
  type HeldOutScenario,
  type TriggerType,
  type TriggerRule,
  type AgentEventType,
  type AgentTimelineEvent,
  type TriggerPoint,
  type UnresolvedTrigger,
  type TriggerPlan,
  type FaultKind,
  type Fault,
  type EdgeConditionKind,
  type EdgeCondition,
  type Soundscape,
  type ScenarioTake,
  type ScriptStep,
  type ScenarioDocument,
  type CorpusManifest,
  type LoadedTake,
  type LoadedScenario,
  type Corpus,
  type CorpusReference,
} from "./types";

export { SCENARIO_REFUSAL_EXIT_CODE, ScenarioError, type ScenarioErrorCode } from "./errors";

export { scenarioFacts, type ScenarioFacts, type ScenarioTakeFact } from "./facts";

export { parseScenario, parseCorpusManifest, type ParseScenarioOptions } from "./parse";

export { assertTriggersResolved, evaluateTriggers } from "./triggers";

export {
  DEFAULT_CORPUS_DIR,
  corpusReference,
  loadCorpus,
  type LoadCorpusOptions,
} from "./corpus";

export { sha256Hex } from "./digest";

export {
  UNHASHED_TAKE_SHA256,
  TAKE_SAMPLE_RATE,
  CALLER_VOICE,
  CARTESIA_TTS_URL,
  CARTESIA_VERSION,
  planTakeGeneration,
  wavFromPcm,
  parseCartesiaSse,
  applyTakeGeneration,
  synthesizeCartesia,
  type TakeState,
  type TakeGenerationPlan,
  type TakeGenerator,
  type TakeGenerationResult,
} from "./generate";

export {
  LOCALE_CORE_LOCALES,
  LOCALE_CORE_SLUGS,
  LOCALE_CORE_RULES,
  LOCALE_CORE_REPETITIONS,
  localeCoreContract,
  localeCorePlan,
  localeCorePropertyIds,
  localeCoreRunCeiling,
  localeCoreScenarioName,
  type LocaleCoreLocale,
  type LocaleCoreSlug,
  type LocaleCoreRule,
  type LocaleCorePlan,
  type LocaleCorePlanEntry,
} from "./locale";

export {
  FAST_CONTRACT_SCENARIOS,
  FAST_CONTRACT_REPETITIONS,
  FAST_CONTRACT_LOCALE,
  CALL_PATH_CAPABILITIES,
  fastContractCoverage,
  fastContractScope,
  fastRunCeilingUsd,
  fastRunPlan,
  judgeFastRun,
  scopeFastVerdict,
  type FastScenarioName,
  type CallPathCapability,
  type FastRunPlan,
  type FastCoverageEntry,
  type FastOutOfScopeFamily,
  type FastScope,
  type FastScopeProperty,
  type FastScopeVerdictValue,
  type FastScopedVerdict,
  type FastCallCost,
  type FastRunEconomy,
  type FastRunTiming,
  type FastRunReport,
} from "./fast";
