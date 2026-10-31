/**
 * The protocol adapter's vocabulary: one diagnosis run over the public call
 * boundary, with no browser in it.
 *
 * A scenario is data (`src/lib/demo/verification/scenarios`). This adapter
 * turns one scenario into one real call through `POST /v1/call-body` and
 * `WS /v1/browser-call`, captures the evidence that call produced, and hands it
 * to the verdict engine unchanged. It never writes a certificate: the spec's
 * certifying adapter is the browser (ticket 17).
 *
 * Spec: `.scratch/demo-verification/spec.md`, "One seam, two adapters" and
 * "Targets, runs and cadence".
 */

import type { CodeFingerprint } from "@/lib/demo/scoreboard";
import type { CardTarget, DefectCard, DefectCardErrorCode } from "@/lib/demo/verification/cards";
import type {
  Corpus,
  CorpusReference,
  Fault,
  LoadedScenario,
  Locale,
  TriggerPlan,
} from "@/lib/demo/verification/scenarios";
import type {
  CallEligibilityFact,
  PropertyEvaluator,
  RunVerdict,
} from "@/lib/demo/verification/verdict";
import type { ProtocolAdapterErrorCode } from "./errors";

/** The adapter every run names. There is exactly one protocol adapter. */
export const PROTOCOL_ADAPTER = "protocol" as const;

export type ProtocolAdapter = typeof PROTOCOL_ADAPTER;

/** The schema version of the per-run directory's `run.json`. */
export const PROTOCOL_RUN_SCHEMA_VERSION = 1 as const;

/** Where run artifacts land. Gitignored: a run is evidence, never a commit. */
export const DEFAULT_RUN_ROOT = ".demo-runs";

/**
 * The committed vendor-build record (RR-03). A missing leg refuses the run; a
 * build id is never recorded as `unknown`. Ticket 11 reads this record and
 * never invents one.
 */
export const DEFAULT_VENDOR_BUILDS_PATH = "../../../evidence/vendor-builds.json";

/** The record's shape: the certificate's `VendorBuild` list, with a version. */
export type VendorBuildRecord = {
  readonly schemaVersion: number;
  readonly builds: readonly VendorBuildEntry[];
};

export type VendorBuildEntry = {
  readonly leg: "stt" | "tts" | "llm" | "judge";
  readonly vendor: string;
  readonly model: string;
  readonly buildId: string;
};

export type ProtocolTargetLabel = CardTarget;

/** The one endpoint pair a protocol run talks to. */
export type ProtocolTarget = {
  readonly httpBase: string;
  readonly wsUrl: string;
  readonly local: boolean;
};

/** One missing startup fact, named so an operator can fix it. */
export type MissingItem = {
  /** A stable machine name, e.g. `META_API_KEY`, `corpus`, `vendor-build:tts`. */
  readonly item: string;
  readonly detail: string;
};

/**
 * The preflight answer. `ok: false` is a named refusal (exit 2), never a skip:
 * a run that cannot name its key, corpus, scenario or vendor build does not
 * start.
 */
export type ProtocolPreflight =
  | {
      readonly ok: true;
      readonly vendorBuilds: readonly VendorBuildEntry[];
      readonly corpus: Corpus;
      readonly scenario: LoadedScenario;
      readonly target: ProtocolTarget;
    }
  | {
      readonly ok: false;
      readonly missing: readonly MissingItem[];
    };

/** A fault the runner actually applied, as opposed to one the scenario asked for. */
export type AppliedFault = {
  readonly kind: Fault["kind"];
  readonly atMs: number;
  readonly durationMs?: number;
  /** What the media seam did, e.g. frames dropped or delayed. */
  readonly observed: string;
};

/** The agent timeline the live trigger resolver observed. */
export type ObservedTimeline = {
  readonly events: readonly { readonly atMs: number; readonly type: string }[];
  /** What the caller actually did, in call time. */
  readonly spoken: readonly {
    readonly step: number;
    readonly take: string;
    readonly atMs: number;
  }[];
};

/** One call's transport result, before evidence assembly. */
export type ProtocolCallResult = {
  readonly callId: string;
  readonly voice: string;
  readonly subject: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly timeline: ObservedTimeline;
  /** Resolved after the call; any unresolved step is a refusal, not a skip. */
  readonly triggerPlan: TriggerPlan;
  readonly faultsApplied: readonly AppliedFault[];
  readonly caller: {
    readonly frames: number;
    readonly bytes: number;
    /** Every caller frame carries this many bytes (128 samples at 24 kHz). */
    readonly frameBytes: number;
  };
  readonly received: {
    /** Raw PCM16, mono, 24 kHz, exactly as the service sent it. */
    readonly pcm: Uint8Array;
    readonly sampleRate: number;
    readonly frames: number;
    readonly bytes: number;
  };
  /** How the call ended, in the transport's words. */
  readonly endedBy: "end" | "end_call" | "closed" | "fault-call-drop" | "timeout";
  /** A named transport problem that did not prevent evidence assembly. */
  readonly error: string | null;
  /** The service's trace path, when the transport knows it. */
  readonly tracePath: string | null;
  /** The service's persisted end sidecar, when the transport knows it. */
  readonly endPath: string | null;
};

/**
 * The call seam the runner consumes. The real implementation talks to the
 * pipeline; tests inject a fake so verdict wiring is exercised without vendors.
 * Nothing above this seam knows a socket exists.
 */
export type ProtocolCallAdapter = (
  input: ProtocolCallInput,
) => Promise<ProtocolCallResult>;

export type ProtocolCallInput = {
  readonly scenario: LoadedScenario;
  readonly callId: string;
  readonly target: ProtocolTarget;
  readonly targetLabel: ProtocolTargetLabel;
  readonly soundscapePcm: Uint8Array | null;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/** The evidence the runner assembles for one call, keyed by the contract's sources. */
export type ProtocolEvidenceBundle = {
  /** The persisted end message and the turn-level ledger. */
  readonly ledger: {
    readonly file: string | null;
    readonly end: Record<string, unknown> | null;
    readonly endGap: string | null;
    readonly turns: readonly Record<string, unknown>[];
    readonly turnIds: readonly string[];
    /** The browser marks stream does not exist on this adapter. */
    readonly marks: null;
    readonly marksGap: string;
  };
  readonly trace: {
    readonly file: string;
    readonly rows: readonly Record<string, unknown>[];
    readonly lineCount: number;
  };
  /** Omitted when no agent audio arrived; a missing source fails closed. */
  readonly wav?: {
    readonly file: string;
    readonly sampleRate: number;
    readonly channels: 1;
    readonly bitsPerSample: 16;
    readonly frames: number;
    readonly durationMs: number;
    readonly bytes: number;
  };
  readonly tool: {
    readonly calls: readonly Record<string, unknown>[];
    readonly results: readonly Record<string, unknown>[];
  };
  /** The call's own priced row, read verbatim. The runner never recomputes cost. */
  readonly cost?: Record<string, unknown>;
};

/** The per-call directory's record. */
export type ProtocolCallRecord = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: Locale;
  readonly target: ProtocolTargetLabel;
  readonly voice: string;
  readonly subject: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly endedBy: ProtocolCallResult["endedBy"];
  readonly error: string | null;
  readonly callerFrames: number;
  readonly callerBytes: number;
  readonly callerFrameBytes: number;
  readonly receivedFrames: number;
  readonly receivedBytes: number;
  readonly timeline: ObservedTimeline;
  readonly triggerPlan: TriggerPlan;
  readonly faultsApplied: readonly AppliedFault[];
  readonly files: {
    readonly trace: string | null;
    readonly end: string | null;
    readonly receivedWav: string | null;
    readonly call: string;
  };
  /** Evidence that did not exist, named rather than papered over. */
  readonly evidenceGaps: readonly string[];
};

/** A card that could not be built, with the named reason. */
export type CardGap = {
  readonly propertyId: string;
  readonly code: DefectCardErrorCode | "no-attribution" | "no-module" | "protocol-withheld";
  readonly detail: string;
};

/** The run's own summary, written to `run.json`. */
export type ProtocolRunRecord = {
  readonly schemaVersion: typeof PROTOCOL_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly adapter: ProtocolAdapter;
  readonly target: ProtocolTargetLabel;
  readonly scenario: string;
  readonly locale: Locale;
  readonly corpus: CorpusReference | null;
  readonly scenarioFingerprint: string | null;
  readonly codeFingerprint: CodeFingerprint | null;
  /** Always false: the protocol adapter diagnoses and never certifies. */
  readonly certifiable: false;
  readonly certification: "withheld";
  readonly certificationReason: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: ProtocolRunStatus;
  readonly call: ProtocolCallRecord | null;
  readonly verdict: {
    readonly verdict: RunVerdict["verdict"];
    readonly failedPropertyIds: readonly string[];
    readonly unknownPropertyIds: readonly string[];
    readonly failures: readonly string[];
    readonly detail: string;
    readonly file: string;
  } | null;
  readonly cards: {
    readonly file: string | null;
    readonly count: number;
    readonly gaps: readonly CardGap[];
  };
  /** Exactly what stayed unrun, and why. Never empty merely because it looks green. */
  readonly unrun: readonly string[];
  readonly refusal: {
    readonly code: ProtocolAdapterErrorCode;
    readonly message: string;
  } | null;
};

/** `clean` means every property passed in diagnosis; it is still not a certificate. */
export const PROTOCOL_RUN_STATUSES = [
  "clean-diagnosis",
  "findings",
  "ineligible",
  "refused",
] as const;

export type ProtocolRunStatus = (typeof PROTOCOL_RUN_STATUSES)[number];

export type ProtocolRunResult = {
  readonly runId: string;
  readonly runDir: string;
  readonly status: ProtocolRunStatus;
  /** 2 on a named refusal; 1 otherwise. 0 is reserved for a certificate. */
  readonly exitCode: 0 | 1 | 2;
  readonly verdict: RunVerdict | null;
  readonly cards: readonly DefectCard[];
  readonly cardGaps: readonly CardGap[];
  readonly call: ProtocolCallRecord | null;
  readonly unrun: readonly string[];
  readonly corpus: CorpusReference | null;
  readonly scenario: LoadedScenario | null;
  readonly target: ProtocolTargetLabel;
  readonly locale: Locale;
};

/** The startup facts a preflight reads; injectable so tests never need vendors. */
export type ProtocolPreflightInput = {
  readonly scenarioName: string;
  readonly target: ProtocolTargetLabel;
  readonly locale: Locale | undefined;
  readonly corpusDir: string | URL;
  readonly knownProperties: ReadonlySet<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly targetUrl: { readonly baseUrl?: string; readonly wsUrl?: string };
  readonly vendorBuilds: VendorBuildRecord | null;
  readonly vendorBuildsPath: string;
  readonly soundscapes: Readonly<Record<string, Uint8Array>>;
};

/** A loaded evaluator set the runner judges with. */
export type ProtocolEvaluators = readonly PropertyEvaluator[];

/** One attribution the runner could prove from the verdict's own citations. */
export type CardAttribution = {
  readonly propertyId: string;
  readonly callId: string;
  readonly turn?: string;
  readonly scenario: string;
};

/** What the evidence assembly learned, including gaps it refuses to hide. */
export type AssembledEvidence = {
  readonly bundle: ProtocolEvidenceBundle;
  readonly eligibility: CallEligibilityFact;
  readonly gaps: readonly string[];
};
