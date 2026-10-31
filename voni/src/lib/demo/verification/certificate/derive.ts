/**
 * The one place a certificate's verdict is computed.
 *
 * `ineligible` wins over every property outcome; any property failure, run
 * failure or coverage gap is `not-demo-ready`; a clean run is `pending-human`
 * until the owner signs, and only then `certified`. The builder and the reader
 * both call this, so a document cannot assert a verdict its facts contradict.
 *
 * H7 (panel signature) is the one failure that does not make an unsigned
 * certificate not-demo-ready: an otherwise clean certificate whose only failed
 * property is the missing signature is exactly what `pending-human` means. A
 * signed certificate that still fails H7 is a real failure.
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
    input.runFailures.length > 0 ||
    input.coverage.gapRows > 0 ||
    input.coverage.byLocale.some((locale) => locale.status === "gap")
  ) {
    return "not-demo-ready";
  }
  const failures = input.properties.filter((property) => property.status === "FAIL");
  const onlySignaturePending =
    input.panel === null &&
    failures.length > 0 &&
    failures.every((property) => property.propertyId === "H7");
  if (failures.length > 0 && !onlySignaturePending) {
    return "not-demo-ready";
  }
  return input.panel === null ? "pending-human" : "certified";
}
