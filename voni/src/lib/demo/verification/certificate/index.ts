/**
 * The certificate: one committed claim per certification run, bound to code,
 * corpus, vendor builds, target and — when signed — the owner's panel.
 *
 * Read `docs/agents/demo-verification.md` for the register a certificate cites
 * and ADR 0013 for why only `certified` may be called a pass.
 */

export {
  CERTIFICATE_SCHEMA_VERSION,
  CERTIFICATE_TARGETS,
  CERTIFICATE_VERDICTS,
  CERTIFICATE_MODES,
  VENDOR_LEGS,
  REQUIRED_VENDOR_LEGS,
  COVERAGE_STATUSES,
  type Certificate,
  type CertificateBuildInput,
  type CertificateCorpus,
  type CertificateCorpusScenario,
  type CertificateCost,
  type CertificateCoverage,
  type CertificateEligibility,
  type CertificateExpectation,
  type CertificateMode,
  type CertificatePlan,
  type CertificateProperty,
  type CertificateResume,
  type CertificateScenarioVerdict,
  type CertificateTarget,
  type CertificateVerdict,
  type CertificateVerdictExit,
  type CertificationAttempt,
  type CoverageRow,
  type CoverageStatus,
  type LocaleCoverage,
  type PanelSignature,
  type VendorBuild,
  type VendorLeg,
} from "./types";

export {
  CERTIFICATE_REFUSAL_EXIT_CODE,
  CertificateError,
  certificateExitCode,
  type CertificateErrorCode,
} from "./errors";

export {
  OPEN_RESIDUAL_RISK_IDS,
  RESIDUAL_RISK_IDS,
  RESIDUAL_RISKS,
  knownResidualRisk,
  type ResidualRisk,
} from "./risks";

export { buildCertificate, certificateLocale } from "./build";

export { deriveCertificateVerdict } from "./derive";

export {
  parseCertificate,
  readCertificate,
  serializeCertificate,
  validateCertificate,
} from "./validate";

export { renderCertificate } from "./render";

export { CERTIFICATES_DIR, certificateFile, certificateFileName } from "./store";
