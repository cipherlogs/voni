/**
 * The one place a certificate's verdict is computed.
 *
 * `ineligible` wins over every property outcome; any property failure, run
 * failure or coverage gap is `not-demo-ready`; a clean run is `pending-human`
 * until the owner signs, and only then `certified`. The builder and the reader
 * both call this, so a document cannot assert a verdict its facts contradict.
 */

import type {
  CertificateCoverage,
  CertificateEligibility,
  CertificateProperty,
  CertificateVerdict,
  PanelSignature,
} from "./types";

export function deriveCertificateVerdict(input: {
  eligibility: CertificateEligibility;
  properties: readonly CertificateProperty[];
  runFailures: readonly string[];
  coverage: CertificateCoverage;
  panel: PanelSignature | null;
}): CertificateVerdict {
  if (!input.eligibility.eligible) return "ineligible";
  if (
    input.properties.some((property) => property.status === "FAIL") ||
    input.runFailures.length > 0 ||
    input.coverage.gapRows > 0 ||
    input.coverage.byLocale.some((locale) => locale.status === "gap")
  ) {
    return "not-demo-ready";
  }
  return input.panel === null ? "pending-human" : "certified";
}
