/**
 * Panel vocabulary: the twelve-call sample, the gold labels the owner's blind
 * ratings become, and the signature that completes the certificate.
 *
 * The panel is the human authority for H1-H5 and H7. A panel session samples
 * twelve calls (two per Locale, or one per scenario class under a one-Locale
 * scope, every failing call mandatory); the ratings are
 * exported as gold labels carrying the session id and reviewer; the owner's
 * signature binds those labels to one certificate. An unsigned certificate is
 * pending-human, never certified.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Judging", "Evidence artifacts"
 * and "Commands and exit codes".
 */

import type { CertificateTarget, PanelSignature } from "../certificate/types";
import type { Locale } from "../scenarios/types";

/** The panel's target sample: twelve calls per certification. */
export const PANEL_SAMPLE_SIZE = 12;

/**
 * Two calls per Locale are the base of the twelve; the two extra slots go to
 * the worst remaining failing calls, and every failing call beyond them is
 * still mandatory (the session grows rather than dropping a failure).
 */
export const PANEL_CALLS_PER_LOCALE = 2;

/**
 * A one-Locale scope cannot draw "two per Locale" as breadth: that is two
 * calls. Its twelve are one clean call per scenario class (the corpus's nine
 * classes give nine), the remaining slots to the worst clean calls, and every
 * failing call mandatory. One per class, not two, because nine classes at two
 * each is eighteen and the sample is fixed at twelve.
 */
export const PANEL_CALLS_PER_CLASS = 1;

/**
 * The panel's 5-point "Would you stay on this call?" axis mapped to the spec's
 * yes/no bar. A rating of 4 or 5 is a yes; 1-3 is a no. This is the fail-closed
 * reading of a scale the spec does not restate as binary (recorded in the
 * panel module's gaps, never used to widen an H1 pass).
 */
export const PANEL_STAY_YES_MIN = 4;

/** The only signature format this effort emits; an unknown prefix is refused. */
export const PANEL_SIGNATURE_PREFIX = "panel-v1:";

/** One blind rating, exported as a gold label for the judges and the panel. */
export type PanelGoldLabel = {
  /** The session that produced it; a label never leaves its session unnamed. */
  readonly sessionId: string;
  /** The call the rater judged, kept private until export. */
  readonly callId: string;
  readonly itemId: string;
  readonly scenario: string;
  readonly locale: Locale;
  /** All seven Studio axes, on the 1-5 scale. */
  readonly axes: Readonly<Record<string, number>>;
  /** True when the rater picked the human baseline as the human side. */
  readonly humanDetected: boolean | null;
  readonly preference: "agent" | "baseline" | "neither" | null;
  readonly ratedAt: string;
};

/**
 * The exported gold labels for one panel session. `digest` pins the exact
 * labels the owner's signature covers; a changed label is a different claim.
 */
export type PanelGoldLabelSet = {
  readonly sessionId: string;
  readonly runId: string;
  readonly reviewer: string;
  /** `YYYY-MM-DD`; the signature is dated, never undated. */
  readonly signedAt: string;
  readonly labels: readonly PanelGoldLabel[];
  readonly digest: string;
};

/** What the H1-H5/H7 gate reads: the signed session and its gold labels. */
export type PanelJudgementInput = {
  readonly goldLabels: PanelGoldLabelSet;
  /** Null while the owner has not signed; H7 then fails as pending-human. */
  readonly signature: PanelSignature | null;
  /**
   * The certificate's declared Locales. H1 and H2 apply their per-Locale bars
   * and the H2 judgement floor to these Locales only: under a one-Locale scope
   * the equivalent of "40 per Locale" is 40 judgments for the one Locale, and a
   * Locale the owner excluded is neutral, never a missing measurement. Omitted
   * means every demo Locale, the pre-scope reading.
   */
  readonly scope?: readonly Locale[];
  /** The certificate facts the signature must bind; checked at signing. */
  readonly certificate?: {
    readonly runId: string;
    readonly target: CertificateTarget;
  };
};
