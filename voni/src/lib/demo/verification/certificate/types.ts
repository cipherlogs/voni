/**
 * The certificate's schema: one committed artifact per certification run.
 *
 * A certificate is the claim, not the account of it. It pins the code
 * fingerprint (with the dirty flag), the target it is true for, the declared
 * certification scope and the owner decision behind it, the corpus version,
 * hash and exact scenario set, the vendor builds, every property verdict with
 * its sample count and citations, explicit coverage rows (gaps included,
 * out-of-scope Locales named rather than dropped), the measured cost as an
 * exact total or a named lower bound with every unpriced leg, the call count,
 * the residual-risk ids, and — when the owner has signed — the panel
 * session and reviewer. Its verdict is one of four, and only `certified` may be
 * called a pass.
 *
 * The schema never carries audio or event bytes: those are gitignored working
 * files, recorded here by path/hash elsewhere. A certificate is committed.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Evidence artifacts", "Targets,
 * runs and cadence" and "Scenario corpus and Locale matrix"; ADR 0013; the
 * declared scope and the English-only decision are recorded in
 * docs/agents/demo-verification.md, "Certification scope".
 */

import type { CodeFingerprint } from "../../scoreboard";
import type { Contract } from "../contract";
import type { CorpusReference, Locale, ScenarioClass } from "../scenarios";
import type { PropertyStatus, PropertyVerdictReason, RunVerdict } from "../verdict";

/**
 * The schema version every committed certificate must carry. Version 4 makes
 * `cost` a measured lower bound with its named unpriced legs, so a reader can
 * never mistake a partial sum for an exact claim. Version 3 makes the
 * certification `scope` required, so a certificate always names the Locales it
 * is a claim about and the owner decision behind that set. Version 2 makes
 * `resume` required (null for a run made in one piece), so a reader can never
 * mistake an interrupted run for a clean one by omission. Version 1
 * certificates stay readable and are read as `resume: null`; all older
 * versions are read as an undeclared scope, which means every demo Locale.
 */
export const CERTIFICATE_SCHEMA_VERSION = 4 as const;

/** The versions a reader understands. Older documents keep their own version. */
export type CertificateSchemaVersion = 1 | 2 | 3 | 4;

/** The targets a certificate may be true for. A green never inherits. */
export const CERTIFICATE_TARGETS = ["local", "staging", "production"] as const;

export type CertificateTarget = (typeof CERTIFICATE_TARGETS)[number];

/** The four certificate verdicts. Only `certified` may be called a pass. */
export const CERTIFICATE_VERDICTS = [
  "certified",
  "not-demo-ready",
  "pending-human",
  "ineligible",
] as const;

export type CertificateVerdict = (typeof CERTIFICATE_VERDICTS)[number];

/** The run plans the spec names; the plan fixes the repetitions a scenario owes. */
export const CERTIFICATE_MODES = [
  "diagnose",
  "fast",
  "nightly",
  "full",
  "cutover",
] as const;

export type CertificateMode = (typeof CERTIFICATE_MODES)[number];

/**
 * The vendor legs a certificate records. The certifying browser path opens
 * STT, TTS and the fast LLM on every call; the judge model is recorded when the
 * machine judges ran. RR-03: an unrecorded build id refuses the run.
 */
export const VENDOR_LEGS = ["stt", "tts", "llm", "judge"] as const;

export type VendorLeg = (typeof VENDOR_LEGS)[number];

/** A leg without a build id is a certificate about a vendor nobody can reproduce. */
export const REQUIRED_VENDOR_LEGS = ["stt", "tts", "llm"] as const;

export type VendorBuild = {
  readonly leg: VendorLeg;
  /** The vendor's name, e.g. "assemblyai"; never a model or a URL. */
  readonly vendor: string;
  /** The model or voice identifier the vendor serves. */
  readonly model: string;
  /** The vendor's immutable build id; `unknown` is never a value. */
  readonly buildId: string;
};

/**
 * Who may declare a certification scope. The demo's scope is an owner
 * decision, never an engineer's convenience: narrowing what a certificate is
 * about is exactly the decision an owner signs for.
 */
export const SCOPE_DECIDERS = ["owner"] as const;

export type ScopeDecider = (typeof SCOPE_DECIDERS)[number];

/** The dated, named decision behind a scope; carried into every out-of-scope row. */
export type ScopeDecision = {
  readonly decidedBy: ScopeDecider;
  /** The day the decision was made, `YYYY-MM-DD`. */
  readonly decidedOn: string;
  /** Why the declared Locales are the claim, in the owner's words. */
  readonly reason: string;
};

/**
 * What a certificate is a claim about. It is an input to the build, never
 * inferred from whatever happened to run: a Locale outside the set is neutral
 * and explicitly recorded as out of scope, while every in-scope Locale must be
 * fully measured or the certificate fails closed.
 */
export type CertificationScope = ScopeDecision & {
  /** Non-empty, unique and drawn from {@link import("../scenarios").LOCALES}. */
  readonly locales: readonly Locale[];
};

/** The owner's signature: a named panel session and reviewer, dated. */
export type PanelSignature = {
  /** The panel session whose gold labels the signature covers. */
  readonly sessionId: string;
  /** The reviewer who rated and signed; a person, not a role. */
  readonly reviewer: string;
  /** The date the signature was made, `YYYY-MM-DD`. */
  readonly signedAt: string;
  /**
   * The attestation the panel flow (ticket 27) produces. Ticket 08 pins that it
   * is present and non-empty; ticket 27 owns producing and verifying it.
   */
  readonly signature: string;
};

/**
 * How a certificate was assembled across an interruption. It names the
 * original run, when it started, when it continued, and the calls each half
 * contributed. A reused call is never presented as freshly measured, and a
 * certificate that spans an interruption says so where the owner reads it.
 */
export type CertificateResume = {
  /** The original run id; it is also the certificate's own run id. */
  readonly journalRunId: string;
  /** The journal this run continued, for audit. */
  readonly journalPath: string;
  readonly originalStartedAt: string;
  readonly resumedAt: string;
  /** Call ids reused from the journal's completed half. */
  readonly reusedCalls: readonly string[];
  /** Call ids the resumed half made. */
  readonly madeCalls: readonly string[];
};

/** What one run planned to execute. Coverage is judged against it. */
export type CertificatePlan = {
  readonly mode: CertificateMode;
  /** Attempts every scenario in the corpus owes in this run. */
  readonly repetitions: number;
};

/** One scenario the run's corpus expects, as the certificate records it. */
export type CertificateCorpusScenario = {
  readonly name: string;
  readonly locale: Locale;
  readonly heldOut: boolean;
  /** The spec's scenario class; the one-Locale panel samples across it. */
  readonly class: ScenarioClass;
};

/**
 * The corpus facts a certificate pins. This is structurally a {@link Corpus}
 * narrowed to what the certificate reads: the version, the hash over every
 * take, and the scenarios (name and Locale) coverage must account for.
 */
export type CertificateCorpus = {
  readonly version: number;
  readonly fingerprint: string;
  readonly scenarios: readonly CertificateCorpusScenario[];
};

/**
 * The corpus facts the committed certificate pins. Version 3 records the exact
 * scenario set the claim covers, so a reader can demand one coverage row per
 * declared scenario; v1/v2 predate it and carry only the version and hash.
 */
export type CertificateCorpusRecord = {
  readonly version: number;
  readonly sha256: string;
  readonly scenarios?: readonly CertificateCorpusScenario[];
};

/** One call the run executed, by scenario, Locale and repetition. */
export type CertificationAttempt = {
  readonly scenario: string;
  readonly locale: Locale;
  /** 1-based repetition index within the plan. */
  readonly repetition: number;
  /** The call the attempt produced, when the adapter reported one. */
  readonly callId?: string;
};

/**
 * A scenario coverage row is measured or an explicit gap; there is no third
 * state. A scenario never becomes out of scope: only its Locale can be, by the
 * declared owner decision, and a Locale that ran is never out of scope.
 */
export const COVERAGE_STATUSES = ["measured", "gap"] as const;

export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** One scenario's coverage. A shortfall is a row, never an omission. */
export type CoverageRow = {
  readonly locale: Locale;
  readonly scenario: string;
  readonly heldOut: boolean;
  /**
   * The scenario's class. Null only on a pre-v3 certificate, which predates the
   * field; every certificate this builder issues records it.
   */
  readonly class: ScenarioClass | null;
  readonly requiredRepetitions: number;
  readonly measuredRepetitions: number;
  readonly status: CoverageStatus;
  /** Named reason for a gap; null only on a measured row. */
  readonly gap: string | null;
  /** The calls that measured this scenario, for audit. Empty on a gap row. */
  readonly calls: readonly string[];
};

/**
 * A Locale is measured, an explicit gap, or out of scope by a recorded owner
 * decision. Out of scope is neutral to the verdict, and only a Locale the
 * declared scope excludes may carry it.
 */
export const LOCALE_COVERAGE_STATUSES = ["measured", "gap", "out-of-scope"] as const;

export type LocaleCoverageStatus = (typeof LOCALE_COVERAGE_STATUSES)[number];

/** One Locale's coverage. Every demo Locale appears, including an empty one. */
export type LocaleCoverage = {
  readonly locale: Locale;
  readonly expectedScenarios: number;
  readonly measuredScenarios: number;
  readonly gapRows: number;
  readonly status: LocaleCoverageStatus;
  /** Named reason when the Locale is a gap; null otherwise. */
  readonly gap: string | null;
  /** The owner decision when the Locale is out of scope; null otherwise. */
  readonly decision: ScopeDecision | null;
};

/**
 * Coverage by Locale and scenario. `expectedScenarios` is the corpus size, so a
 * dropped row is a count mismatch the validator can refuse; `gapRows` counts
 * scenario gaps, and a Locale row is itself a gap when it is short.
 */
export type CertificateCoverage = {
  readonly expectedScenarios: number;
  readonly gapRows: number;
  readonly rows: readonly CoverageRow[];
  readonly byLocale: readonly LocaleCoverage[];
};

/** One scenario's contribution to a certificate property verdict. */
export type CertificateScenarioVerdict = {
  readonly scenario: string;
  readonly locale?: Locale;
  readonly status: PropertyStatus;
  readonly reason: PropertyVerdictReason;
  readonly sampleCount: number;
  readonly citations: readonly string[];
};

/** One property's verdict, with the sample count and citations 08 and 09 need. */
export type CertificateProperty = {
  readonly propertyId: string;
  readonly family: string;
  readonly status: PropertyStatus;
  readonly reason: PropertyVerdictReason;
  readonly sampleCount: number;
  readonly citations: readonly string[];
  /** Recorded gaps that weaken the property; they never turn it green. */
  readonly gaps: readonly string[];
  readonly scenarios: readonly CertificateScenarioVerdict[];
};

/** Why a run was ineligible; an ineligible certificate is never a pass. */
export type CertificateEligibility = {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
};

/**
 * One leg a call's own priced row left unpriced. `source` is the row's own
 * words for the missing unit; the certificate never paraphrases it.
 */
export type CertificateUnpricedLeg = {
  readonly callId: string;
  readonly leg: string;
  readonly unit: string;
  readonly source: string;
};

/**
 * Cost is read from the calls' own priced rows, never recomputed here.
 *
 * `usdMeasured` is the sum of every priced row and leg the vendors reported.
 * It is exact only when `complete` is true. When a designed turn cut stops the
 * vendor before its usage chunk, the unpriced leg is named instead of priced:
 * `usdMeasured` is then a lower bound, never the exact cost, and no leg is a
 * zero stand-in.
 */
export type CertificateCost = {
  readonly usdMeasured: number;
  /** True only when every priced leg was measured; a bound is never exact. */
  readonly complete: boolean;
  readonly callCount: number;
  /** The legs the vendors never reported, each with the row's own reason. */
  readonly unpriced: readonly CertificateUnpricedLeg[];
};

/** The committed certificate. */
export type Certificate = {
  /**
   * The document's own version, preserved on read. A v1/v2 certificate is
   * re-serialized as itself; only a v3 document carries a declared scope and
   * the corpus scenario set.
   */
  readonly schemaVersion: CertificateSchemaVersion;
  readonly runId: string;
  /** The one target this certificate is true for. */
  readonly target: CertificateTarget;
  /**
   * The Locales this certificate is a claim about, and the owner decision that
   * set them. Null only for a pre-v3 certificate, which declared no scope and
   * is read as requiring every demo Locale.
   */
  readonly scope: CertificationScope | null;
  readonly code: {
    readonly fingerprint: CodeFingerprint;
    /** The app build/deploy the run served, e.g. a git SHA or image tag. */
    readonly appBuild: string;
    /** The pipeline image digest the run served. */
    readonly pipelineImage: string;
  };
  readonly corpus: CertificateCorpusRecord;
  readonly vendorBuilds: readonly VendorBuild[];
  readonly plan: CertificatePlan;
  readonly coverage: CertificateCoverage;
  readonly properties: readonly CertificateProperty[];
  readonly eligibility: CertificateEligibility;
  /**
   * Run-level structural failures the verdict core named (duplicate evidence,
   * unknown property ids, a retry). They never vanish into a green.
   */
  readonly runFailures: readonly string[];
  readonly cost: CertificateCost;
  /** Every residual risk that still applies; an unknown id is refused. */
  readonly residualRiskIds: readonly string[];
  /** Null until the owner has signed; then the panel session and reviewer. */
  readonly panel: PanelSignature | null;
  /** Null for a run made in one piece; set when it was resumed. */
  readonly resume: CertificateResume | null;
  readonly verdict: CertificateVerdict;
  /** True only for `certified`; every other verdict is not a pass. */
  readonly pass: boolean;
};

/** What the builder reads. It never invents a value the run did not record. */
export type CertificateBuildInput = {
  readonly contract: Contract;
  /** The verdict core's run result (ticket 07); every property appears in it. */
  readonly run: RunVerdict;
  readonly target: CertificateTarget;
  /** The declared claim; required. A run outside it refuses, it never narrows. */
  readonly scope: CertificationScope;
  readonly plan: CertificatePlan;
  readonly corpus: CertificateCorpus;
  readonly attempts: readonly CertificationAttempt[];
  readonly codeFingerprint: CodeFingerprint;
  readonly appBuild: string;
  readonly pipelineImage: string;
  readonly vendorBuilds: readonly VendorBuild[];
  /** Measured cost and the calls it covers; never a default or a zero stand-in. */
  readonly cost: CertificateCost;
  readonly residualRiskIds: readonly string[];
  readonly panel?: PanelSignature | null;
  /** Set only when this certificate was assembled across an interruption. */
  readonly resume?: CertificateResume | null;
};

/** What a reader must prove before it may use a certificate for a run. */
export type CertificateExpectation = {
  readonly target?: CertificateTarget;
  readonly runId?: string;
  readonly codeFingerprint?: CodeFingerprint;
  readonly corpus?: CorpusReference;
  /** The Locale set the consumer demands; a different claim is refused. */
  readonly scope?: readonly Locale[];
};

/** A named refusal; every certificate error is exit 2 (bad input/evidence). */
export type CertificateVerdictExit = 0 | 1 | 2 | 3;
