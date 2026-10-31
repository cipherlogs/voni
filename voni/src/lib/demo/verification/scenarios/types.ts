/**
 * A scenario is data, never code: caller takes with trigger rules, a
 * soundscape, the contract properties the run must judge, and the faults the
 * run must inject.
 *
 * Nothing here names a browser, a socket or a runner. The certifying browser
 * adapter and the diagnosis protocol adapter read the same record; if a field
 * could only be honoured by one of them, it does not belong in this file.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "One seam, two adapters" and
 * "Scenario corpus and Locale matrix".
 */

/** The schema version every committed `scenario.json` must carry. */
export const SCENARIO_SCHEMA_VERSION = 1;

/** The schema version every corpus `manifest.json` must carry. */
export const CORPUS_SCHEMA_VERSION = 1;

/** The file a scenario directory must contain. */
export const SCENARIO_FILE = "scenario.json";

/** The file a corpus root must contain, beside one directory per scenario. */
export const CORPUS_MANIFEST_FILE = "manifest.json";

/**
 * The spec's ten scenario classes. The corpus is 40 English scenarios in these
 * classes; tickets 12–16 add the scenarios, this file only names the classes.
 */
export const SCENARIO_CLASSES = [
  "golden-flow",
  "turn-taking",
  "comprehension",
  "emotion",
  "soundscape",
  "connectivity",
  "meta-security",
  "ending",
  "tools",
  "locale",
] as const;

export type ScenarioClass = (typeof SCENARIO_CLASSES)[number];

/** The Locale core: English plus the four locales the spec certifies. */
export const LOCALES = ["en", "es", "fr", "de", "pt"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * The eight held-out scenarios, verbatim from the spec. They are sealed by
 * process (residual risk RR-07): the machine can only enforce that the mark is
 * present on exactly these names and absent everywhere else.
 */
export const HELD_OUT_SCENARIOS = [
  "sarcastic",
  "distressed",
  "second-voice",
  "speakerphone",
  "prompt-injection",
  "two-tools-in-turn",
  "mispronounced-email",
  "caller-hangup-mid-word",
] as const;

export type HeldOutScenario = (typeof HELD_OUT_SCENARIOS)[number];

/**
 * When a caller take starts, relative to the agent's observed timeline. Each
 * rule resolves to one absolute call time; the evaluator is pure, so the same
 * timeline always yields the same trigger points.
 */
export const TRIGGER_TYPES = [
  /** The call is open; the caller speaks first. */
  "call-open",
  /** The agent has started speaking: the caller talks over it. */
  "agent-speech-start",
  /** The agent's turn is finished: the caller answers. */
  "agent-turn-end",
  /** The agent has been silent for `silenceMs`; the caller fills the pause. */
  "silence",
  /** A fixed offset from call open, for a caller that ignores the agent. */
  "at-offset",
] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type TriggerRule =
  | { readonly type: "call-open"; readonly delayMs?: number }
  | { readonly type: "agent-speech-start"; readonly delayMs?: number }
  | { readonly type: "agent-turn-end"; readonly delayMs?: number }
  | { readonly type: "silence"; readonly silenceMs: number; readonly delayMs?: number }
  | { readonly type: "at-offset"; readonly atMs: number };

/**
 * The agent-side events both adapters report, in call time. A trigger rule is
 * resolved against this timeline and nothing else: no wall clock, no sleep, no
 * adapter-specific event.
 */
export const AGENT_EVENT_TYPES = [
  "call-open",
  "agent-speech-start",
  "agent-speech-end",
  "agent-turn-end",
  "call-end",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type AgentTimelineEvent = {
  readonly atMs: number;
  readonly type: AgentEventType;
};

/** One caller take, resolved to the call time it starts. */
export type TriggerPoint = {
  readonly step: number;
  readonly take: string;
  readonly trigger: TriggerType;
  readonly atMs: number;
};

/** A script step whose event never arrived; the run fails by name, never skips it. */
export type UnresolvedTrigger = {
  readonly step: number;
  readonly take: string;
  readonly trigger: TriggerType;
  readonly reason: string;
};

export type TriggerPlan = {
  readonly points: readonly TriggerPoint[];
  readonly unresolved: readonly UnresolvedTrigger[];
};

/**
 * Conditions the runner injects at the media seam. Ticket 11 applies them to
 * the protocol adapter and ticket 17 to the browser adapter; both read this
 * record, so a fault may never be adapter-specific.
 *
 * The spec names "faults" without enumerating them; this vocabulary is the
 * schema's and grows by editing this list and its tests, never by accepting an
 * unknown string at load.
 */
export const FAULT_KINDS = [
  /** A gap in the caller or agent media stream. */
  "audio-dropout",
  /** Delivery-time jitter, without a gap. */
  "network-jitter",
  /** Added endpoint latency, as a poor network would produce. */
  "endpoint-latency",
  /** The call ends abruptly at the fault point. */
  "call-drop",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export type Fault = {
  readonly kind: FaultKind;
  /** Call time the fault begins. */
  readonly atMs: number;
  /** How long it lasts; omitted for an instantaneous fault such as `call-drop`. */
  readonly durationMs?: number;
};

/** A named background condition the adapter mixes under the call. */
export type Soundscape = {
  readonly id: string;
  /** Mix level in dB, when the scenario pins one; omitted means the adapter's documented default. */
  readonly levelDb?: number;
};

/**
 * One recorded caller line. `sha256` pins the bytes, so retaking a line is a
 * deliberate edit to this record rather than a silent change of comparability.
 */
export type ScenarioTake = {
  readonly id: string;
  /** Path relative to the scenario directory; it may never escape it. */
  readonly audio: string;
  readonly sha256: string;
  /** The words spoken, when the take carries a transcript. */
  readonly text?: string;
};

/** One ordered caller step: which take, and the rule that starts it. */
export type ScriptStep = {
  readonly take: string;
  readonly trigger: TriggerRule;
};

/** The validated scenario record. */
export type ScenarioDocument = {
  readonly schemaVersion: number;
  readonly name: string;
  readonly class: ScenarioClass;
  readonly locale: Locale;
  readonly heldOut: boolean;
  readonly expectedProperties: readonly string[];
  readonly soundscape: Soundscape;
  readonly faults: readonly Fault[];
  /**
   * How long the harness keeps an otherwise finished call open before it hangs
   * up. A greeting-only scenario sets this so the line's waiting time is a real
   * measurement rather than the harness's teardown.
   */
  readonly holdOpenMs?: number;
  readonly takes: readonly ScenarioTake[];
  readonly script: readonly ScriptStep[];
};

/** The corpus manifest: one version for every take, recomputed on any change. */
export type CorpusManifest = {
  readonly schemaVersion: number;
  readonly version: number;
};

/** A take whose bytes were hashed at load and matched the declared digest. */
export type LoadedTake = ScenarioTake & {
  /** The file the loader read, resolved inside the scenario directory. */
  readonly path: string;
  readonly bytes: number;
};

/** A validated scenario with its directory and a fingerprint over all of it. */
export type LoadedScenario = Omit<ScenarioDocument, "takes"> & {
  readonly directory: string;
  readonly takes: readonly LoadedTake[];
  /** sha256 over the validated record and every take's actual digest. */
  readonly fingerprint: string;
};

/**
 * The discovered corpus. `fingerprint` is what a certificate pins: the version
 * says comparability was deliberately moved, the hash says the exact bytes.
 */
export type Corpus = {
  readonly version: number;
  readonly fingerprint: string;
  readonly scenarios: readonly LoadedScenario[];
};

/** What a certificate cites about the corpus it ran. */
export type CorpusReference = {
  readonly version: number;
  readonly sha256: string;
};
