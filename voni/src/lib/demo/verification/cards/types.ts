/**
 * A defect card's shape: the pointer triage starts with.
 *
 * One card is produced per failed property. It is built from the verdict that
 * failed — never from prose and never from a default — plus the call evidence
 * that names the session, the turn, the audio excerpt and the files. A card
 * that cannot name a turn (for a turn-level property) or an existing evidence
 * file is refused, so no failure is triaged from an unverifiable pointer.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Evidence artifacts".
 */

import type { FamilyId, ResolvedThreshold } from "../contract";
import type { Locale } from "../scenarios";
import type {
  PropertyVerdictReason,
  RunVerdict,
  ThresholdCheck,
} from "../verdict";

/** The targets the spec lets `demo:verify` name. */
export const CARD_TARGETS = ["local", "staging", "production"] as const;

export type CardTarget = (typeof CARD_TARGETS)[number];

/**
 * Severity is a triage class derived from the property's family, not from the
 * author's mood: `critical` can mislead, harm or break a visitor's call;
 * `major` is a worse-than-bar experience; `minor` is a human-taste proxy.
 */
export const SEVERITIES = ["critical", "major", "minor"] as const;

export type Severity = (typeof SEVERITIES)[number];

/** The two audio artifacts an excerpt may resolve inside. */
export const EXCERPT_MEDIA = ["caller-take", "delivered-wav"] as const;

export type ExcerptMedia = (typeof EXCERPT_MEDIA)[number];

/**
 * One bounded span of one named WAV. `startMs`/`endMs` are call-relative and
 * must resolve inside the file the evidence names; the builder reads the WAV
 * header rather than trusting a declared duration.
 */
export type AudioExcerpt = {
  readonly media: ExcerptMedia;
  readonly file: string;
  readonly startMs: number;
  readonly endMs: number;
};

/** One turn's evidence as the runner assembled it. */
export type TurnEvidence = {
  /** The logical turn the ledger writes, e.g. `1:reply`. */
  readonly turn: string;
  /** The caller take played on this turn, when there was one. */
  readonly callerTake?: string;
  /** The delivered WAV captured for this call. */
  readonly deliveredWav?: string;
  /** One excerpt per media, each bounded by the file it names. */
  readonly excerpts?: readonly AudioExcerpt[];
  /** Files this turn produced: the trace row's source, marks, end doc. */
  readonly evidenceFiles: readonly string[];
};

/** One call's evidence, keyed by the session id the ledger names. */
export type CallEvidence = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: Locale;
  readonly target: CardTarget;
  readonly turns: readonly TurnEvidence[];
  /** The delivered WAV when the call has one at call level. */
  readonly deliveredWav?: string;
  /** Call-level excerpts for a property that is judged per call, not per turn. */
  readonly excerpts?: readonly AudioExcerpt[];
  /** Call-level files: the end document, the priced row, the browser marks. */
  readonly evidenceFiles: readonly string[];
};

/**
 * Which call and turn one failed property belongs to. The runner assembles it
 * from the evidence its evaluator measured; a missing attribution is a refusal,
 * never a card without a pointer.
 */
export type DefectAttribution = {
  readonly propertyId: string;
  readonly callId: string;
  /** Required for a turn-level property, forbidden-free otherwise. */
  readonly turn?: string;
  /** Narrows the failed scenario when the property failed in more than one. */
  readonly scenario?: string;
};

export type BuildDefectCardsInput = {
  /** The verdict that failed; the card reads its property, bar and observed value. */
  readonly verdict: Pick<RunVerdict, "runId" | "properties">;
  readonly target: CardTarget;
  readonly calls: readonly CallEvidence[];
  readonly attributions: readonly DefectAttribution[];
  /** Repo-relative module paths per property. A line number is refused. */
  readonly modules: Readonly<Record<string, readonly string[]>>;
  /** Where module pointers resolve; a pointer to nothing is refused. */
  readonly repoRoot: string;
};

export type DefectCardExpectedBar = {
  readonly text: string;
  readonly numeric: boolean;
  /** The frozen numbers the bar resolved to; empty for a categorical bar. */
  readonly thresholds: readonly ResolvedThreshold[];
};

export type DefectCardObserved = {
  /** The first failing check's value; null for a categorical bar. */
  readonly value: number | null;
  readonly unit: string;
  readonly statistic: string | null;
  readonly detail: string;
  /** Every failing check, so the card does not hide a second breach. */
  readonly checks: readonly ThresholdCheck[];
};

export type DefectCardCitation = {
  /** The call id: the session the triage starts from. */
  readonly session: string;
  readonly scenario: string;
  readonly locale: Locale;
  readonly target: CardTarget;
  /** The logical turn, or null for a call-level property. */
  readonly turn: string | null;
  /** Why a call-level card carries no turn; null when it carries one. */
  readonly turnAbsence: string | null;
  readonly audioExcerpts: readonly AudioExcerpt[];
  readonly evidenceFiles: readonly string[];
};

export type DefectCard = {
  readonly id: string;
  readonly propertyId: string;
  readonly property: string;
  readonly family: FamilyId;
  readonly scenario: string;
  readonly locale: Locale;
  readonly target: CardTarget;
  readonly expectedBar: DefectCardExpectedBar;
  readonly observed: DefectCardObserved;
  readonly severity: Severity;
  readonly citation: DefectCardCitation;
  readonly modules: readonly string[];
  /** The exact command that reproduces this scenario, target and Locale. */
  readonly replayCommand: string;
  readonly detail: string;
  readonly verdictReason: PropertyVerdictReason;
  /** Recorded gaps that weaken the property; they never turn it green. */
  readonly gaps: readonly string[];
};
