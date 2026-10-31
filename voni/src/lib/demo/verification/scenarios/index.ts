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

export { parseScenario, parseCorpusManifest, type ParseScenarioOptions } from "./parse";

export { assertTriggersResolved, evaluateTriggers } from "./triggers";

export {
  DEFAULT_CORPUS_DIR,
  corpusReference,
  loadCorpus,
  type LoadCorpusOptions,
} from "./corpus";
