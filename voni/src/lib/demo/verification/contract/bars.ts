/**
 * The committed contract bar record and its drift test.
 *
 * The record pins, per property, the frozen threshold keys and the numbers
 * they resolved to, plus the digest of each source record. It is not a
 * threshold source: editing a number in `scoreboard-budgets.json` or the
 * cascade registry changes the live resolution, and `checkContractBars` fails
 * until the bar record is moved deliberately with `npm run contract:bars --
 * --write`. Editing the bar record alone fails the same test.
 */

import { readFileSync } from "node:fs";

import { ContractRegistryError } from "./errors";
import type { Contract, ContractBarRecord, ResolvedThreshold, ThresholdTables } from "./types";

export const CONTRACT_BARS_PATH = new URL("./contract-bars.json", import.meta.url);

export const CONTRACT_BARS_NOTE =
  "The resolved bars for the 82-property demo-verification contract. A threshold " +
  "edit is a spec change: it must move the frozen record it quotes, this record " +
  "and the drift test together. Regenerate with `npm run contract:bars -- --write` " +
  "after a reviewed threshold change; never hand-edit a number.";

export type ContractBarRecordProperty = {
  unresolved: boolean;
  thresholds: ResolvedThreshold[];
};

/** Snapshot the live contract's resolved bars; the committed record must equal it. */
export function buildContractBarRecord(
  contract: Contract,
  tables: ThresholdTables,
): ContractBarRecord {
  const properties: Record<string, ContractBarRecordProperty> = {};
  for (const property of contract.properties) {
    properties[property.id] = {
      unresolved: Boolean(property.unresolved),
      thresholds: property.thresholds.map((threshold) => ({ ...threshold })),
    };
  }
  return {
    version: 1,
    note: CONTRACT_BARS_NOTE,
    sources: {
      "budget-record": { ...tables.sources["budget-record"] },
      "cascade-thresholds": { ...tables.sources["cascade-thresholds"] },
    },
    properties,
  };
}

export function readContractBarRecord(
  location: URL | string = CONTRACT_BARS_PATH,
): ContractBarRecord {
  let text: string;
  try {
    text = readFileSync(location, "utf8");
  } catch (error) {
    throw new ContractRegistryError(
      "unreadable-record",
      `cannot read the contract bar record at ${String(location)}: ${String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ContractRegistryError(
      "malformed-record",
      `the contract bar record at ${String(location)} is not valid JSON: ${String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContractRegistryError(
      "malformed-record",
      `the contract bar record at ${String(location)} is not an object`,
    );
  }
  return parsed as ContractBarRecord;
}

export type ContractBarDriftReason =
  | "source-missing"
  | "source-extra"
  | "source-digest-changed"
  | "property-missing"
  | "property-extra"
  | "unresolved-changed"
  | "threshold-missing"
  | "threshold-extra"
  | "value-changed"
  | "unit-changed";

export type ContractBarDrift = {
  reason: ContractBarDriftReason;
  propertyId: string | null;
  source: ResolvedThreshold["source"] | null;
  key: string | null;
  live: string | number | boolean | null;
  record: string | number | boolean | null;
};

const SOURCES = ["budget-record", "cascade-thresholds"] as const;

/**
 * Compare two bar records. Empty means the contract still describes the frozen
 * records it quotes. A changed number, a moved digest, a dropped property or a
 * new threshold is drift.
 */
export function checkContractBars(
  live: ContractBarRecord,
  record: ContractBarRecord,
): ContractBarDrift[] {
  const drift: ContractBarDrift[] = [];

  for (const source of SOURCES) {
    const liveSource = live.sources?.[source];
    const recordSource = record.sources?.[source];
    if (!recordSource) {
      drift.push({
        reason: "source-missing",
        propertyId: null,
        source,
        key: null,
        live: liveSource?.path ?? null,
        record: null,
      });
      continue;
    }
    if (!liveSource) {
      drift.push({
        reason: "source-extra",
        propertyId: null,
        source,
        key: null,
        live: null,
        record: recordSource.path,
      });
      continue;
    }
    if (liveSource.path !== recordSource.path) {
      drift.push({
        reason: "source-extra",
        propertyId: null,
        source,
        key: "path",
        live: liveSource.path,
        record: recordSource.path,
      });
    }
    if (liveSource.sha256 !== recordSource.sha256) {
      drift.push({
        reason: "source-digest-changed",
        propertyId: null,
        source,
        key: "sha256",
        live: liveSource.sha256,
        record: recordSource.sha256,
      });
    }
  }

  const propertyIds = [...new Set([...Object.keys(live.properties ?? {}), ...Object.keys(record.properties ?? {})])].sort();
  for (const propertyId of propertyIds) {
    const liveProperty = live.properties?.[propertyId];
    const recordProperty = record.properties?.[propertyId];
    if (!recordProperty) {
      drift.push({
        reason: "property-missing",
        propertyId,
        source: null,
        key: null,
        live: liveProperty.thresholds.length,
        record: null,
      });
      continue;
    }
    if (!liveProperty) {
      drift.push({
        reason: "property-extra",
        propertyId,
        source: null,
        key: null,
        live: null,
        record: recordProperty.thresholds.length,
      });
      continue;
    }
    if (liveProperty.unresolved !== recordProperty.unresolved) {
      drift.push({
        reason: "unresolved-changed",
        propertyId,
        source: null,
        key: "unresolved",
        live: liveProperty.unresolved,
        record: recordProperty.unresolved,
      });
    }

    const byKey = (thresholds: readonly ResolvedThreshold[]) =>
      new Map(thresholds.map((threshold) => [`${threshold.source}#${threshold.key}`, threshold]));
    const liveThresholds = byKey(liveProperty.thresholds);
    const recordThresholds = byKey(recordProperty.thresholds);
    const keys = [...new Set([...liveThresholds.keys(), ...recordThresholds.keys()])].sort();
    for (const key of keys) {
      const liveThreshold = liveThresholds.get(key);
      const recordThreshold = recordThresholds.get(key);
      if (!recordThreshold) {
        drift.push({
          reason: "threshold-missing",
          propertyId,
          source: liveThreshold?.source ?? null,
          key: liveThreshold?.key ?? key,
          live: liveThreshold?.value ?? null,
          record: null,
        });
        continue;
      }
      if (!liveThreshold) {
        drift.push({
          reason: "threshold-extra",
          propertyId,
          source: recordThreshold.source,
          key: recordThreshold.key,
          live: null,
          record: recordThreshold.value,
        });
        continue;
      }
      if (liveThreshold.value !== recordThreshold.value) {
        drift.push({
          reason: "value-changed",
          propertyId,
          source: liveThreshold.source,
          key: liveThreshold.key,
          live: liveThreshold.value,
          record: recordThreshold.value,
        });
      }
      if (liveThreshold.unit !== recordThreshold.unit) {
        drift.push({
          reason: "unit-changed",
          propertyId,
          source: liveThreshold.source,
          key: liveThreshold.key,
          live: liveThreshold.unit,
          record: recordThreshold.unit,
        });
      }
    }
  }

  return drift;
}
