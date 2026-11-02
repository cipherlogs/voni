/**
 * The browser adapter's vocabulary: the certifying run.
 *
 * A browser call is one real Chromium visit to the real landing page. The
 * harness owns the microphone by replacing `getUserMedia` before app code runs,
 * and the call's evidence is read from the real artifacts the app and pipeline
 * wrote: the delivered WAV, the browser marks, the trace and the end document.
 * Nothing above the call seam knows a page exists.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "One seam, two adapters".
 */

import type { CodeFingerprint } from "@/lib/demo/scoreboard";
import type { ToolLogRow } from "@/lib/demo/tool-log";
import type { InboxDelivery } from "@/lib/demo/verification/tools/inbox";
import type { CardTarget, DefectCard } from "@/lib/demo/verification/cards";
import type {
  Corpus,
  CorpusReference,
  LoadedScenario,
  Locale,
  TriggerPlan,
} from "@/lib/demo/verification/scenarios";
import type { CallMarksArtifact } from "@/lib/voice/call-marks";
import type {
  CallEligibilityFact,
  RunVerdict,
} from "@/lib/demo/verification/verdict";

import type { BrowserAdapterErrorCode } from "./errors";
import type {
  AppliedFault,
  CardGap,
  MissingItem,
  ObservedTimeline,
  VendorBuildEntry,
  VendorBuildRecord,
} from "../protocol-adapter/types";

export type {
  AppliedFault,
  CardGap,
  MissingItem,
  ObservedTimeline,
  VendorBuildEntry,
  VendorBuildRecord,
};

/** The adapter every certifying run names. */
export const BROWSER_ADAPTER = "browser" as const;

export type BrowserAdapter = typeof BROWSER_ADAPTER;

/** The schema version of the per-run directory's `run.json`. */
export const BROWSER_RUN_SCHEMA_VERSION = 1 as const;

/** Where run artifacts land. Gitignored: a run is evidence, never a commit. */
export const DEFAULT_BROWSER_RUN_ROOT = ".demo-runs";

/** The app's gitignored dev capture directory, relative to `voni/`. */
export const DEFAULT_CAPTURES_DIR = ".captures";

/**
 * The one browser harness. The runner spawns this Playwright spec; tests
 * inject a fake call so the verdict wiring runs without Chromium.
 */
export const BROWSER_SPEC = "tests/e2e/browser-adapter.spec.ts";

/** The Playwright project the certifying run uses: one real viewport. */
export const BROWSER_PROJECT = "desktop";

/** The page the certifying run opens. */
export const LANDING_PATH = "/?delivercapture=1";

export type BrowserTargetLabel = CardTarget;

/** The one app and pipeline pair a browser run talks to. */
export type BrowserTarget = {
  readonly appUrl: string;
  readonly pipelineUrl: string;
  /** True only for a loopback app and pipeline; a remote stack needs its own evidence sink. */
  readonly local: boolean;
};

/**
 * What the browser harness observed at the edge: the page, the microphone, the
 * device, the transport and the deploy. These are the visitor's own machine
 * changing under the call, not a fake pipeline inside it.
 */
export type EdgeObservation = {
  readonly conditions: readonly {
    readonly kind: string;
    readonly atMs: number;
    readonly durationMs?: number;
    readonly applied: boolean;
    readonly observed: string;
  }[];
  /** A freeze/hide hold: the stop and the return, with the clock read on each side. */
  readonly hold: {
    readonly enteredAtMs: number;
    readonly returnedAtMs: number | null;
    readonly holdingObserved: boolean;
    readonly talkClockAtEnterS: number;
    readonly talkClockAtReturnS: number | null;
    readonly stateAtEnter: string;
    readonly stateAtReturn: string | null;
    /** True when the return painted "connecting" (the ringback's trigger). */
    readonly ringbackObserved: boolean;
    readonly greetingCountAtEnter: number;
    readonly greetingCountAtReturn: number | null;
  } | null;
  /** A denied microphone: the named state and the sockets left behind. */
  readonly micDenied: {
    readonly namedState: string;
    readonly errorText: string;
    readonly socketOpenAfterMs: number;
    readonly openSockets: number;
    readonly teardownObserved: boolean;
  } | null;
  /** A mid-call input device change: recovered, honestly ended, or neither. */
  readonly deviceSwitch: {
    readonly atMs: number;
    readonly reacquired: boolean;
    readonly state: string;
    readonly endedHonestly: boolean;
  } | null;
  /** The deploy drain trial: one live call finishing, one new call refused. */
  readonly drain: {
    readonly liveCallFinished: boolean;
    readonly newCallAttempted: boolean;
    readonly newCallRefused: boolean;
    readonly refusalCode: string | null;
    readonly refusalText: string | null;
  } | null;
};

/** What the browser harness actually did to the microphone. */
export type SyntheticMicReport = {
  /** Always `getUserMedia`: the harness owns the mic at the browser API. */
  readonly method: "getUserMedia";
  /** Epoch ms the init script ran, before any app code. */
  readonly installedAt: number;
  /** True when the install predates the app's first mark. */
  readonly installedBeforeAppCode: boolean;
  /** Every caller take the harness played, in call time. */
  readonly takesPlayed: readonly {
    readonly step: number;
    readonly take: string;
    readonly atMs: number;
    readonly durationMs: number;
    /** Wall-clock start, set by the harness; absent from an older report. */
    readonly epochMs?: number;
  }[];
  /** The browser's audio context rate, when the page reported it. */
  readonly sampleRate: number | null;
};

/** One call's result from the browser harness, before evidence assembly. */
export type BrowserCallResult = {
  /**
   * The call id signed into the mint's demo call token, read independently of
   * the marks receipt. Null only when the mint itself did not land.
   */
  readonly callId: string | null;
  readonly voice: string;
  readonly subject: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly timeline: ObservedTimeline;
  /** Resolved after the call; any unresolved step is a refusal, not a skip. */
  readonly triggerPlan: TriggerPlan;
  readonly faultsApplied: readonly AppliedFault[];
  readonly syntheticMic: SyntheticMicReport;
  /** The browser-edge conditions this call produced; null when none ran. */
  readonly edge?: EdgeObservation | null;
  /** The real sockets and pages this call opened, recorded for the refusal check. */
  readonly browser: {
    readonly appUrl: string;
    readonly pipelineWsUrl: string;
    readonly userAgent: string;
    readonly markCount: number | null;
    readonly captureName: string | null;
  };
  /** The artifacts the app wrote, resolved by the harness after teardown. */
  readonly marksPath: string | null;
  readonly capturePath: string | null;
  /** How the call ended, in the harness's words. */
  readonly endedBy: "caller-hangup" | "agent-end" | "call-drop" | "timeout";
  /** The visitor's transcript, read from the page before teardown. */
  readonly captions?: readonly {
    readonly role: "caller" | "agent";
    readonly text: string;
  }[];
  /** A named harness problem that did not stop evidence assembly. */
  readonly error: string | null;
  readonly tracePath: string | null;
  readonly endPath: string | null;
  /** The measured browser phase, in milliseconds; the declared ceiling applies to it. */
  readonly elapsedMs: number;
};

/**
 * The call seam the runner consumes. The real implementation drives Chromium
 * through the Playwright spec; tests inject a fake so verdict wiring is
 * exercised without a browser. Nothing above this seam knows a page exists.
 */
export type BrowserCallAdapter = (
  input: BrowserCallInput,
) => Promise<BrowserCallResult>;

export type BrowserCallInput = {
  readonly scenario: LoadedScenario;
  readonly target: BrowserTarget;
  /** Where the real app writes its gitignored delivered WAV and marks. */
  readonly capturesDir: string;
  readonly eventsDir: string;
  readonly runDir: string;
  readonly elapsedBudgetS: number | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The scenario's ambience as interleaved 24 kHz mono PCM16, or null for quiet-room. */
  readonly soundscapePcm?: Uint8Array | null;
  /** The scenario's mix level in dB; omitted means the adapter's default. */
  readonly soundscapeLevelDb?: number;
};

/** The evidence the runner assembles for one browser call. */
export type BrowserEvidenceBundle = {
  /** The persisted end message, the turn ledger and the browser marks. */
  readonly ledger: {
    /** Null when the call never reached the service (a denied microphone). */
    readonly file: string | null;
    readonly end: Record<string, unknown> | null;
    readonly endGap: string | null;
    readonly turns: readonly Record<string, unknown>[];
    readonly turnIds: readonly string[];
    /** Null when the client posted no marks; the gap then names why. */
    readonly marks: CallMarksArtifact | null;
    readonly marksGap: string;
  };
  readonly trace: {
    readonly file: string | null;
    readonly rows: readonly Record<string, unknown>[];
    readonly lineCount: number;
    /**
     * The visitor's final lines, joined to the call clock through the client's
     * own per-turn marks. Absent when the page rendered none or the line count
     * and the turn marks disagree; the gap then names why, never a guess.
     */
    readonly transcript: readonly {
      readonly role: "caller" | "agent";
      readonly text: string;
      readonly atMs: number;
      readonly final: true;
      readonly turn: null;
    }[] | null;
    readonly transcriptGap: string | null;
  };
  /**
   * The worklet's rendered output. Null only for a denied microphone, where
   * the tap never opened; the gap names the absent audio and nothing is faked.
   */
  readonly wav: {
    readonly file: string;
    readonly sampleRate: number;
    readonly channels: 1;
    readonly bitsPerSample: 16;
    readonly frames: number;
    readonly durationMs: number;
    readonly bytes: number;
  } | null;
  readonly tool: {
    readonly calls: readonly Record<string, unknown>[];
    readonly results: readonly Record<string, unknown>[];
    /** The demo tool log's redacted fact rows, when the app database was read. */
    readonly log?: readonly ToolLogRow[];
    /** The real inbox's delivery record, when it could be re-read. */
    readonly delivery?: InboxDelivery;
    /** Why the log or delivery is absent, named for the verdict. */
    readonly gap?: string;
  };
  /** The call's own priced row, read verbatim. The runner never recomputes cost. */
  readonly cost?: Record<string, unknown>;
  /** The browser's own evidence: the marks artifact beside the delivered WAV. */
  readonly browser: {
    /** Null when the client posted no marks; the gap names why. */
    readonly file: string | null;
    readonly marks: CallMarksArtifact | null;
    /** The visitor's transcript, read from the page at teardown. */
    readonly captions?: readonly {
      readonly role: "caller" | "agent";
      readonly text: string;
    }[];
    /** Null only for a denied microphone, which never delivered audio. */
    readonly capture: {
      readonly file: string;
      readonly name: string;
      readonly bytes: number;
      readonly sampleRate: number;
      readonly seconds: number;
    } | null;
    readonly syntheticMic: SyntheticMicReport;
    /** The scenario's applied media faults, with what each actually did. */
    readonly faultsApplied: readonly AppliedFault[];
    /** The browser-edge observations R2–R7 are judged from. */
    readonly edge: EdgeObservation | null;
  };
};

/** What the evidence assembly learned, including gaps it refuses to hide. */
export type AssembledBrowserEvidence = {
  readonly bundle: BrowserEvidenceBundle;
  readonly eligibility: CallEligibilityFact;
  readonly gaps: readonly string[];
};

/** The per-call directory's record. */
export type BrowserCallRecord = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: Locale;
  readonly target: BrowserTargetLabel;
  readonly voice: string;
  readonly subject: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly endedBy: BrowserCallResult["endedBy"];
  readonly error: string | null;
  readonly timeline: ObservedTimeline;
  readonly triggerPlan: TriggerPlan;
  readonly faultsApplied: readonly AppliedFault[];
  readonly syntheticMic: SyntheticMicReport;
  readonly edge: EdgeObservation | null;
  readonly browser: BrowserCallResult["browser"];
  readonly elapsedMs: number;
  readonly files: {
    readonly trace: string | null;
    readonly end: string | null;
    readonly deliveredWav: string | null;
    readonly marks: string | null;
    readonly call: string;
  };
  /** Every artifact that exists cites this call id; false is a refusal, never a warning. */
  readonly sameCallId: true;
  /** Evidence that did not exist, named rather than papered over. */
  readonly evidenceGaps: readonly string[];
};

export const BROWSER_RUN_STATUSES = [
  "certified",
  "pending-human",
  "not-demo-ready",
  "ineligible",
  "refused",
] as const;

export type BrowserRunStatus = (typeof BROWSER_RUN_STATUSES)[number];

/** A card that could not be built, with the named reason. */
export type BrowserCardGap = CardGap;

/** The parity comparison a `--parity` run records. */
export type BrowserParityRecord = {
  readonly agree: boolean;
  readonly scenario: string;
  readonly comparedPropertyIds: readonly string[];
  readonly disagreements: readonly {
    readonly kind: string;
    readonly propertyId: string | null;
    readonly detail: string;
  }[];
  readonly notCompared: readonly string[];
  /** The protocol run's directory, when parity was asked for. */
  readonly protocolRunDir: string | null;
};

/** The run's own summary, written to `run.json`. */
export type BrowserRunRecord = {
  readonly schemaVersion: typeof BROWSER_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly adapter: BrowserAdapter;
  readonly target: BrowserTargetLabel;
  readonly scenario: string;
  readonly locale: Locale;
  readonly corpus: CorpusReference | null;
  readonly scenarioFingerprint: string | null;
  readonly codeFingerprint: CodeFingerprint | null;
  /** True only for this adapter: a browser run can certify. */
  readonly certifiable: true;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: BrowserRunStatus;
  readonly call: BrowserCallRecord | null;
  readonly certification: "issued" | "withheld";
  readonly certificationReason: string | null;
  readonly certificate: {
    readonly file: string;
    readonly verdict: "certified" | "not-demo-ready" | "pending-human" | "ineligible";
    readonly pass: boolean;
  } | null;
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
    readonly gaps: readonly BrowserCardGap[];
  };
  readonly browserBudget: {
    readonly bound: string;
    readonly ceilingS: number | null;
    readonly measuredMs: number | null;
    /**
     * `within`/`over` need a measured elapsed time. A run with a declared
     * ceiling but no measurement is `unknown` (INFO), never `within`: an
     * unmeasured budget is not a pass.
     */
    readonly status: "within" | "over" | "unknown" | "unset";
    readonly line: string;
  };
  /** Exactly what stayed unrun, and why. Never empty merely because it looks green. */
  readonly unrun: readonly string[];
  readonly parity: BrowserParityRecord | null;
  readonly refusal: {
    readonly code: BrowserAdapterErrorCode;
    readonly message: string;
  } | null;
};

/** An adapter's named refusal, as the CLI reports it. */
export type AdapterRefusal = {
  readonly code: string;
  readonly message: string;
};

export type BrowserRunResult = {
  readonly runId: string;
  readonly runDir: string;
  readonly status: BrowserRunStatus;
  /**
   * The one attempt this call produced, for a caller that judges several calls
   * together (a multi-scenario certification run owns the run's one
   * certificate). Null on a refusal.
   */
  readonly attempt: import("@/lib/demo/verification/verdict").ScenarioAttempt | null;
  /** The call's own eligibility facts, so a multi-scenario judge keeps them. */
  readonly eligibility:
    | import("@/lib/demo/verification/verdict").CallEligibilityFact
    | null;
  /** The pipeline build the run served; a run certificate records it. */
  readonly pipelineImage: string | null;
  /**
   * The call's own priced row when it served one, even on a refusal. A run
   * that failed after spending must carry the row so a journal total does not
   * understate it; null means nothing was priced, never a zero.
   */
  readonly cost: Record<string, unknown> | null;
  /** 0 certified, 1 not-demo-ready, 2 a named refusal, 3 pending the human panel. */
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly verdict: RunVerdict | null;
  readonly certificateFile: string | null;
  readonly cards: readonly DefectCard[];
  readonly cardGaps: readonly BrowserCardGap[];
  readonly call: BrowserCallRecord | null;
  readonly unrun: readonly string[];
  readonly corpus: CorpusReference | null;
  readonly scenario: LoadedScenario | null;
  readonly target: BrowserTargetLabel;
  readonly locale: Locale;
  readonly parity: BrowserParityRecord | null;
  /**
   * The adapter's own named refusal (a preflight gap, a capture fault, a
   * missing artifact). Null when the run produced a verdict. A caller reports
   * this, never a gap line: `unrun` carries INFO beside the cause.
   */
  readonly refusal: AdapterRefusal | null;
};

/** The startup facts a preflight reads; injectable so tests never need a stack. */
export type BrowserPreflightInput = {
  readonly scenarioName: string;
  readonly target: BrowserTargetLabel;
  readonly locale: Locale | undefined;
  readonly corpusDir: string | URL;
  readonly knownProperties: ReadonlySet<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appUrl: string;
  readonly pipelineUrl: string;
  readonly vendorBuilds: VendorBuildRecord | null;
  readonly vendorBuildsPath: string;
  readonly soundscapes: Readonly<Record<string, Uint8Array>>;
  /** The one network seam; tests answer without a server. */
  readonly probe?: BrowserStackProbe;
};

/** One response the preflight needs from the real stack. */
export type BrowserStackProbeResponse = {
  readonly status: number;
  readonly body?: unknown;
};

/** `GET`/`POST` the app and pipeline; tests inject a fake. */
export type BrowserStackProbe = (
  method: "GET" | "POST",
  url: string,
) => Promise<BrowserStackProbeResponse>;

export type BrowserPreflight =
  | {
      readonly ok: true;
      readonly vendorBuilds: readonly VendorBuildEntry[];
      readonly corpus: Corpus;
      readonly scenario: LoadedScenario;
      readonly target: BrowserTarget;
      /** The pipeline's reported build; a certificate records it. */
      readonly pipelineBuild: string;
    }
  | {
      readonly ok: false;
      readonly missing: readonly MissingItem[];
    };
