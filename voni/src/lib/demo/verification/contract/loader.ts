/**
 * The contract loader: discover one file per family, validate every property,
 * resolve every numeric bar from a frozen record, and refuse anything that
 * cannot be judged by name.
 *
 * Discovery is by directory scan (`*.family.ts`), never a checked-in list, so
 * a later ticket adds its family or evaluator module without editing this file.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ContractRegistryError } from "./errors";
import { resolveThresholds, type ThresholdTableOptions, loadThresholdTables } from "./thresholds";
import {
  EVIDENCE_SOURCES,
  FAMILIES,
  PROPERTY_KINDS,
  repetitionsFor,
  type Contract,
  type ContractFamily,
  type ContractFamilySummary,
  type ContractProperty,
  type ContractPropertyEntry,
  type EvidenceSource,
  type FamilyId,
  type PropertyKind,
  type ThresholdRef,
  type ThresholdTables,
} from "./types";

/** Where the ten family modules live. A new family is a new file here. */
export const FAMILIES_DIR = new URL("./families/", import.meta.url);

const FAMILY_FILE = /\.family\.ts$/;

/** Read and import every family module in `dir`. */
export async function loadContractFamilies(
  dir: URL | string = FAMILIES_DIR,
): Promise<ContractFamily[]> {
  const path = dir instanceof URL ? fileURLToPath(dir) : dir;
  let entries: string[];
  try {
    entries = (await readdir(path)).filter((name) => FAMILY_FILE.test(name)).sort();
  } catch (error) {
    throw new ContractRegistryError(
      "unreadable-record",
      `cannot read the contract family directory at ${path}: ${String(error)}`,
    );
  }
  if (entries.length === 0) {
    throw new ContractRegistryError(
      "unknown-family",
      `the contract family directory at ${path} holds no *.family.ts module`,
    );
  }
  const modules = await Promise.all(
    entries.map(async (name) => {
      const imported = (await import(pathToFileURL(join(path, name)).href)) as {
        default?: unknown;
      };
      return { name, exported: imported.default };
    }),
  );
  return modules.map(({ name, exported }) => {
    if (typeof exported !== "object" || exported === null) {
      throw new ContractRegistryError(
        "unknown-family",
        `family module ${name} has no default contract family export`,
      );
    }
    return exported as ContractFamily;
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate and resolve the discovered families. Pure and synchronous so the
 * refusal tests can inject a broken family without touching the real table.
 */
export function buildContract(
  families: readonly ContractFamily[],
  tables: ThresholdTables,
): Contract {
  const order = new Map<FamilyId, number>(FAMILIES.map((family, index) => [family, index]));
  const seenFamilies = new Set<string>();
  const seenIds = new Map<string, string>();
  const summaries: ContractFamilySummary[] = [];
  const properties: ContractPropertyEntry[] = [];

  for (const family of families) {
    const familyId = typeof family === "object" && family !== null ? family.family : undefined;
    if (typeof familyId !== "string" || !order.has(familyId as FamilyId)) {
      throw new ContractRegistryError(
        "unknown-family",
        `unknown contract family "${String(familyId)}"; known families: ${FAMILIES.join(", ")}`,
      );
    }
    if (seenFamilies.has(familyId)) {
      throw new ContractRegistryError(
        "duplicate-family",
        `contract family "${familyId}" is declared twice; one file per family`,
      );
    }
    seenFamilies.add(familyId);

    const declared: readonly ContractProperty[] = Array.isArray(family.properties)
      ? family.properties
      : [];
    if (declared.length === 0) {
      throw new ContractRegistryError(
        "empty-family",
        `contract family "${familyId}" declares no properties`,
      );
    }

    for (const property of declared) {
      const id = text(property.id);
      if (id.length === 0) {
        throw new ContractRegistryError(
          "missing-statement",
          `family "${familyId}" has a property with no id`,
        );
      }
      const previous = seenIds.get(id);
      if (previous) {
        throw new ContractRegistryError(
          "duplicate-property",
          `duplicate property id "${id}" in families "${previous}" and "${familyId}"; ` +
            "an id has exactly one owner",
        );
      }
      seenIds.set(id, familyId);

      const statement = text(property.statement);
      if (statement.length === 0) {
        throw new ContractRegistryError(
          "missing-statement",
          `property "${id}" is missing its statement`,
        );
      }

      const bar = property.bar;
      const barText = typeof bar === "object" && bar !== null ? text(bar.text) : "";
      if (barText.length === 0 || typeof bar?.numeric !== "boolean") {
        throw new ContractRegistryError(
          "missing-bar",
          `property "${id}" is missing its bar (text and numeric flag are both required)`,
        );
      }

      const evidence = property.evidence;
      if (!(EVIDENCE_SOURCES as readonly string[]).includes(evidence)) {
        throw new ContractRegistryError(
          "unknown-evidence",
          `property "${id}" names unknown evidence source "${String(evidence)}"; ` +
            `known sources: ${EVIDENCE_SOURCES.join(", ")}`,
        );
      }

      const kind = property.kind;
      if (!(PROPERTY_KINDS as readonly string[]).includes(kind)) {
        throw new ContractRegistryError(
          "invalid-kind",
          `property "${id}" names unknown kind "${String(kind)}"; ` +
            `known kinds: ${PROPERTY_KINDS.join(", ")}`,
        );
      }

      const refs: readonly ThresholdRef[] = Array.isArray(property.thresholds)
        ? property.thresholds
        : [];
      const seenRefs = new Set<string>();
      for (const ref of refs) {
        const refKey = `${String(ref?.source)}#${String(ref?.key)}`;
        if (seenRefs.has(refKey)) {
          throw new ContractRegistryError(
            "duplicate-threshold",
            `property "${id}" names threshold ${refKey} twice; one key per bar`,
          );
        }
        seenRefs.add(refKey);
      }

      if (bar.numeric) {
        if (refs.length === 0) {
          throw new ContractRegistryError(
            "numeric-bar-without-threshold",
            `property "${id}" has a numeric bar but names no frozen threshold key`,
          );
        }
      } else if (refs.length > 0) {
        throw new ContractRegistryError(
          "threshold-on-categorical-bar",
          `property "${id}" has a categorical bar but names threshold ${String(
            refs[0]?.source,
          )}#${String(refs[0]?.key)}`,
        );
      }

      const resolved = resolveThresholds(id, refs, tables).map((value, index) => ({
        source: refs[index].source,
        key: refs[index].key,
        value: value.value,
        unit: value.unit,
      }));

      const unresolvedReason = property.unresolved ? text(property.unresolved.reason) : "";
      if (property.unresolved && unresolvedReason.length === 0) {
        throw new ContractRegistryError(
          "missing-statement",
          `property "${id}" is marked unresolved without a reason`,
        );
      }

      const gaps = Array.isArray(property.gaps)
        ? property.gaps.map((gap: string) => text(gap)).filter((gap: string) => gap.length > 0)
        : [];

      properties.push({
        id,
        family: familyId as FamilyId,
        statement,
        bar: { text: barText, numeric: bar.numeric },
        evidence: evidence as EvidenceSource,
        kind: kind as PropertyKind,
        repetitions: repetitionsFor(kind as PropertyKind),
        thresholds: resolved,
        ...(property.unresolved ? { unresolved: { reason: unresolvedReason } } : {}),
        ...(gaps.length > 0 ? { gaps } : {}),
      });
    }

    summaries.push({
      id: familyId as FamilyId,
      title: text(family.title),
      propertyCount: declared.length,
    });
  }

  summaries.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  const familyPosition = new Map(summaries.map((summary, index) => [summary.id, index]));
  properties.sort((left, right) => {
    const familyDelta =
      (familyPosition.get(left.family) ?? 0) - (familyPosition.get(right.family) ?? 0);
    if (familyDelta !== 0) return familyDelta;
    return 0;
  });

  return { families: summaries, properties };
}

export type LoadContractOptions = ThresholdTableOptions & {
  /** Tests and probe runs read another directory; production reads FAMILIES_DIR. */
  familiesDir?: URL | string;
  /** An already-loaded table, so a drift probe can supply edited numbers. */
  tables?: ThresholdTables;
};

/** Discover, validate and resolve the committed contract. */
export async function loadContract(options: LoadContractOptions = {}): Promise<Contract> {
  const families = await loadContractFamilies(options.familiesDir ?? FAMILIES_DIR);
  const tables = options.tables ?? loadThresholdTables(options);
  return buildContract(families, tables);
}

/** The one property by id; unknown ids are a named refusal, not `undefined`. */
export function requireProperty(contract: Contract, id: string): ContractPropertyEntry {
  const property = contract.properties.find((entry) => entry.id === id);
  if (!property) {
    throw new ContractRegistryError("unknown-property", `unknown contract property "${id}"`);
  }
  return property;
}
