/**
 * The certificate's schema: one committed artifact per certification run.
 *
 * A certificate is the claim, not the account of it. It pins the code
 * fingerprint (with the dirty flag), the target it is true for, the corpus
 * version and hash, the vendor builds, every property verdict with its sample
 * count and citations, explicit coverage rows (gaps included), the measured
 * cost and call count, the residual-risk ids, and — when the owner has signed —
 * the panel session and reviewer. Its verdict is one of four, and only
 * `certified` may be called a pass.
 *
 * The schema never carries audio or event bytes: those are gitignored working
 * files, recorded here by path/hash elsewhere. A certificate is committed.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Evidence artifacts" and
 * "Targets, runs and cadence"; ADR 0013.
 */

import type { CodeFingerprint } from "../../scoreboard";
import type { Contract } from "../contract";
import type { CorpusReference, Locale } from "../scenarios";
import type { PropertyStatus, PropertyVerdictReason, RunVerdict } from "../verdict";

/** The schema version every committed certificate must carry. */
export const CERTIFICATE_SCHEMA_VERSION = 1 as const;

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

/** One call the run executed, by scenario, Locale and repetition. */
export type CertificationAttempt = {
  readonly scenario: string;
  readonly locale: Locale;
  /** 1-based repetition index within the plan. */
  readonly repetition: number;
  /** The call the attempt produced, when the adapter reported one. */
  readonly callId?: string;
};

/** A coverage row is measured or an explicit gap; there is no third state. */
export const COVERAGE_STATUSES = ["measured", "gap"] as const;

export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** One scenario's coverage. A shortfall is a row, never an omission. */
export type CoverageRow = {
  readonly locale: Locale;
  readonly scenario: string;
  readonly heldOut: boolean;
  readonly requiredRepetitions: number;
  readonly measuredRepetitions: number;
  readonly status: CoverageStatus;
  /** Named reason for a gap; null only on a measured row. */
  readonly gap: string | null;
  /** The calls that measured this scenario, for audit. Empty on a gap row. */
  readonly calls: readonly string[];
};

/** One Locale's coverage. Every demo Locale appears, including an empty one. */
export type LocaleCoverage = {
  readonly locale: Locale;
  readonly expectedScenarios: number;
  readonly measuredScenarios: number;
  readonly gapRows: number;
  readonly status: CoverageStatus;
  /** Named reason when the Locale is a gap; null only when fully measured. */
  readonly gap: string | null;
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

/** Cost is read from the calls' own priced rows, never recomputed here. */
export type CertificateCost = {
  readonly usd: number;
  readonly callCount: number;
};

/** The committed certificate. */
export type Certificate = {
  readonly schemaVersion: typeof CERTIFICATE_SCHEMA_VERSION;
  readonly runId: string;
  /** The one target this certificate is true for. */
  readonly target: CertificateTarget;
  readonly code: {
    readonly fingerprint: CodeFingerprint;
    /** The app build/deploy the run served, e.g. a git SHA or image tag. */
    readonly appBuild: string;
    /** The pipeline image digest the run served. */
    readonly pipelineImage: string;
  };
  readonly corpus: CorpusReference;
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
};

/** What a reader must prove before it may use a certificate for a run. */
export type CertificateExpectation = {
  readonly target?: CertificateTarget;
  readonly runId?: string;
  readonly codeFingerprint?: CodeFingerprint;
  readonly corpus?: CorpusReference;
};

/** A named refusal; every certificate error is exit 2 (bad input/evidence). */
export type CertificateVerdictExit = 0 | 1 | 2 | 3;
