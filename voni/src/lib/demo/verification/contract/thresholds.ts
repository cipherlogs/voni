/**
 * Resolution of contract keys against the two frozen threshold owners.
 *
 * The contract registry owns no number. A family file names a key, and this
 * module reads the value from:
 *
 * - `scoreboard-budgets.json` — the frozen demo budget record, with units from
 *   `scoreboard-budgets.ts` (the table the record's freeze guard pins), and
 * - `voice-pipeline/cascade/thresholds.json` — the cascade bounds registry,
 *   including entries that are themselves backed by the budget record.
 *
 * The digest of each record is captured here so the committed contract bar
 * record can prove the numbers it resolved have not moved. A missing, open or
 * malformed entry is a named refusal; nothing is defaulted.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SCOREBOARD_BUDGETS } from "../../scoreboard-budgets";
import { ContractRegistryError } from "./errors";
import {
  THRESHOLD_SOURCES,
  type ThresholdRef,
  type ThresholdSource,
  type ThresholdTables,
  type ThresholdValue,
} from "./types";

/** The frozen record every demo gate quotes. */
export const BUDGET_RECORD_PATH = "voni/src/lib/demo/scoreboard-budgets.json";
/** The cascade's own bounds registry (ticket 06 only reads it). */
export const CASCADE_THRESHOLDS_PATH = "voice-pipeline/cascade/thresholds.json";

const DEFAULT_BUDGET_RECORD = new URL("../../scoreboard-budgets.json", import.meta.url);
const DEFAULT_CASCADE_THRESHOLDS = new URL(
  "../../../../../../voice-pipeline/cascade/thresholds.json",
  import.meta.url,
);

type JsonObject = Record<string, unknown>;

function readObject(location: URL | string, label: string): { data: JsonObject; sha256: string } {
  let text: string;
  try {
    text = readFileSync(location, "utf8");
  } catch (error) {
    throw new ContractRegistryError(
      "unreadable-record",
      `cannot read ${label} at ${location}: ${String(error)}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ContractRegistryError(
      "malformed-record",
      `${label} at ${location} is not valid JSON: ${String(error)}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ContractRegistryError("malformed-record", `${label} at ${location} is not an object`);
  }
  return {
    data: data as JsonObject,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function budgetValues(data: JsonObject, location: URL | string): Record<string, ThresholdValue> {
  const budgets = data.budgets;
  if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) {
    throw new ContractRegistryError(
      "malformed-record",
      `budget record at ${location} has no 'budgets' object`,
    );
  }
  const values: Record<string, ThresholdValue> = {};
  for (const [key, raw] of Object.entries(budgets as JsonObject)) {
    const entry = (SCOREBOARD_BUDGETS as Record<string, { value: number; unit: string } | undefined>)[key];
    if (!entry) {
      throw new ContractRegistryError(
        "malformed-record",
        `budget record at ${location} carries ${key}, which the frozen table does not declare`,
      );
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new ContractRegistryError(
        "malformed-record",
        `budget record at ${location} carries a non-numeric value for ${key}`,
      );
    }
    values[key] = { value: raw, unit: entry.unit };
  }
  return values;
}

function cascadeValues(
  data: JsonObject,
  location: URL | string,
  budgets: Record<string, ThresholdValue>,
): Record<string, ThresholdValue> {
  const bounds = data.bounds;
  if (typeof bounds !== "object" || bounds === null || Array.isArray(bounds)) {
    throw new ContractRegistryError(
      "malformed-record",
      `cascade threshold registry at ${location} has no 'bounds' object`,
    );
  }
  const values: Record<string, ThresholdValue> = {};
  for (const [key, raw] of Object.entries(bounds as JsonObject)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ContractRegistryError(
        "malformed-record",
        `cascade bound ${key} at ${location} is not an object`,
      );
    }
    const entry = raw as JsonObject;
    const unit = entry.unit;
    if (typeof unit !== "string" || unit.length === 0) {
      throw new ContractRegistryError(
        "malformed-record",
        `cascade bound ${key} at ${location} does not name its unit`,
      );
    }
    if (typeof entry.value === "number" && Number.isFinite(entry.value)) {
      values[key] = { value: entry.value, unit };
      continue;
    }
    // Record-backed cascade bounds carry no literal; follow the key so the
    // contract sees the same one-record value the Python loader serves.
    if (typeof entry.budget_key === "string" && entry.budget_key.length > 0) {
      const backed = budgets[entry.budget_key];
      if (backed) values[key] = { value: backed.value, unit };
      continue;
    }
    // An open bound stays unresolved: a ref to it is refused by name below.
  }
  return values;
}

export type ThresholdTableOptions = {
  budgetRecord?: URL | string;
  cascadeThresholds?: URL | string;
};

/** Read both frozen records once; the digests are what the bar record pins. */
export function loadThresholdTables(options: ThresholdTableOptions = {}): ThresholdTables {
  const budgetLocation = options.budgetRecord ?? DEFAULT_BUDGET_RECORD;
  const cascadeLocation = options.cascadeThresholds ?? DEFAULT_CASCADE_THRESHOLDS;
  const budget = readObject(budgetLocation, "budget record");
  const cascade = readObject(cascadeLocation, "cascade threshold registry");
  const budgets = budgetValues(budget.data, budgetLocation);
  return {
    sources: {
      "budget-record": {
        path: describeLocation(options.budgetRecord, budgetLocation, BUDGET_RECORD_PATH),
        sha256: budget.sha256,
      },
      "cascade-thresholds": {
        path: describeLocation(
          options.cascadeThresholds,
          cascadeLocation,
          CASCADE_THRESHOLDS_PATH,
        ),
        sha256: cascade.sha256,
      },
    },
    values: {
      "budget-record": budgets,
      "cascade-thresholds": cascadeValues(cascade.data, cascadeLocation, budgets),
    },
  };
}

function describeLocation(
  override: URL | string | undefined,
  location: URL | string,
  committed: string,
): string {
  if (typeof override === "undefined") return committed;
  return location instanceof URL ? fileURLToPath(location) : location;
}

/**
 * Resolve one property's keys. A ref to an unknown source, an absent key or an
 * open bound is refused by name, so an evaluator never receives a default.
 */
export function resolveThresholds(
  propertyId: string,
  refs: readonly ThresholdRef[],
  tables: ThresholdTables,
): ThresholdValue[] {
  return refs.map((ref) => {
    if (!(THRESHOLD_SOURCES as readonly string[]).includes(ref.source)) {
      throw new ContractRegistryError(
        "unknown-threshold-source",
        `property "${propertyId}" names unknown threshold source "${String(ref.source)}"; ` +
          `known sources: ${THRESHOLD_SOURCES.join(", ")}`,
      );
    }
    const source = ref.source as ThresholdSource;
    const value = tables.values[source]?.[ref.key];
    if (!value) {
      throw new ContractRegistryError(
        "unrecorded-threshold",
        `property "${propertyId}" names ${source}#${ref.key}, which has no recorded value ` +
          `(an open or missing bound is never defaulted)`,
      );
    }
    return value;
  });
}
