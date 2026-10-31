/**
 * The one place a certificate's verdict is computed.
 *
 * `ineligible` wins over every property outcome; any property failure, run
 * failure or coverage gap is `not-demo-ready`; a clean run is `pending-human`
 * until the owner signs, and only then `certified`. The builder and the reader
 * both call this, so a document cannot assert a verdict its facts contradict.
 *
 * The panel owns H1-H5 and H7. Before the panel has run there are no gold
 * labels, so those properties carry a structural failure (`no-evaluator`,
 * `unmeasured`, ...) rather than a measured bar miss. Those are exactly what
 * `pending-human` means and they may not be turned into a green: any other
 * failure reason, including a below-bar panel verdict, is `not-demo-ready`.
 * Once a panel signature is present every property is a real verdict.
 */

import type {
  CertificateCoverage,
  CertificateEligibility,
  CertificateProperty,
  CertificateVerdict,
  PanelSignature,
} from "./types";

/** The human properties the panel owns; a machine evaluator never judges them. */
export const PANEL_OWNED_PROPERTIES = ["H1", "H2", "H3", "H4", "H5", "H7"] as const;

/**
 * Failure reasons that mean "the panel has not measured this yet", not "the
 * panel measured it and it missed the bar".
 */
const PANEL_PENDING_REASONS: ReadonlySet<string> = new Set([
  "no-evaluator",
  "unmeasured",
  "missing-evidence",
  "empty-sample",
  "skipped",
  "unresolved",
]);

export function deriveCertificateVerdict(input: {
  eligibility: CertificateEligibility;
  properties: readonly CertificateProperty[];
  runFailures: readonly string[];
  coverage: CertificateCoverage;
  panel: PanelSignature | null;
}): CertificateVerdict {
  if (!input.eligibility.eligible) return "ineligible";
  if (
    input.runFailures.length > 0 ||
    input.coverage.gapRows > 0 ||
    input.coverage.byLocale.some((locale) => locale.status === "gap")
  ) {
    return "not-demo-ready";
  }
  const failures = input.properties.filter((property) => property.status === "FAIL");
  const onlyPanelPending =
    input.panel === null &&
    failures.length > 0 &&
    failures.every(
      (property) =>
        (PANEL_OWNED_PROPERTIES as readonly string[]).includes(property.propertyId) &&
        PANEL_PENDING_REASONS.has(property.reason),
    );
  if (failures.length > 0 && !onlyPanelPending) {
    return "not-demo-ready";
  }
  return input.panel === null ? "pending-human" : "certified";
}
