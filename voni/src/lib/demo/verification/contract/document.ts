/**
 * The machine-readable contract document. The certificate and the report read
 * this, never the family modules: the shape is one schema version, the family
 * counts, and every property with its resolved bar, evidence source, sample
 * plan and unresolved/gap state.
 */

import {
  EVIDENCE_SOURCES,
  FAMILIES,
  THRESHOLD_SOURCES,
  type Contract,
  type ContractPropertyEntry,
  type ResolvedThreshold,
} from "./types";

export const CONTRACT_SCHEMA_VERSION = 1;

export type ContractDocumentProperty = Omit<
  ContractPropertyEntry,
  "thresholds" | "unresolved" | "gaps"
> & {
  thresholds: ResolvedThreshold[];
  unresolved: boolean;
  unresolvedReason?: string;
  gaps?: string[];
};

export type ContractDocument = {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  propertyCount: number;
  familyCount: number;
  families: Contract["families"][number][];
  properties: ContractDocumentProperty[];
  /** The vocabularies, so a reader can refuse a value it does not know. */
  vocabulary: {
    families: readonly string[];
    evidenceSources: readonly string[];
    thresholdSources: readonly string[];
  };
};

function documentProperty(entry: ContractPropertyEntry): ContractDocumentProperty {
  const { unresolved, gaps, ...rest } = entry;
  return {
    ...rest,
    thresholds: entry.thresholds.map((threshold) => ({ ...threshold })),
    unresolved: Boolean(unresolved),
    ...(unresolved ? { unresolvedReason: unresolved.reason } : {}),
    ...(gaps ? { gaps: [...gaps] } : {}),
  };
}

/** Serialize the loaded contract; the result is JSON-safe and stable. */
export function contractDocument(contract: Contract): ContractDocument {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    propertyCount: contract.properties.length,
    familyCount: contract.families.length,
    families: contract.families.map((family) => ({ ...family })),
    properties: contract.properties.map(documentProperty),
    vocabulary: {
      families: [...FAMILIES],
      evidenceSources: [...EVIDENCE_SOURCES],
      thresholdSources: [...THRESHOLD_SOURCES],
    },
  };
}
