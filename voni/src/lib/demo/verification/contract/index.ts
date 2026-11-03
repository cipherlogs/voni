/**
 * The demo-verification contract: 82 properties in ten families, one file per
 * family, discovered at load, every numeric bar resolved from a frozen record.
 *
 * Read `docs/agents/demo-verification.md` for the subsystem map and ADR 0013
 * for the decisions this table enforces.
 */

export {
  FAMILIES,
  EVIDENCE_SOURCES,
  THRESHOLD_SOURCES,
  PROPERTY_KINDS,
  repetitionsFor,
  type FamilyId,
  type EvidenceSource,
  type ThresholdSource,
  type ThresholdRef,
  type PropertyKind,
  type Bar,
  type UnresolvedProperty,
  type ContractProperty,
  type ContractFamily,
  type ResolvedThreshold,
  type ContractPropertyEntry,
  type ContractFamilySummary,
  type Contract,
  type ThresholdValue,
  type ThresholdTables,
  type ContractBarSourcePin,
  type ContractBarRecord,
} from "./types";

export { ContractRegistryError, type ContractErrorCode } from "./errors";

export {
  BUDGET_RECORD_PATH,
  CASCADE_THRESHOLDS_PATH,
  loadThresholdTables,
  resolveThresholds,
  type ThresholdTableOptions,
} from "./thresholds";

export {
  FAMILIES_DIR,
  buildContract,
  loadContract,
  loadContractFamilies,
  requireProperty,
  type LoadContractOptions,
} from "./loader";

export {
  CONTRACT_SCHEMA_VERSION,
  contractDocument,
  type ContractDocument,
  type ContractDocumentProperty,
} from "./document";

export {
  CONTRACT_BARS_NOTE,
  CONTRACT_BARS_PATH,
  buildContractBarRecord,
  checkContractBars,
  readContractBarRecord,
  type ContractBarDrift,
  type ContractBarDriftReason,
  type ContractBarRecordProperty,
} from "./bars";
