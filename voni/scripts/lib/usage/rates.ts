/**
 * The committed cascade rate tables, read by the version a priced row cites.
 *
 * A row was priced with one named table (`cascade-vendor-rates v1`). This
 * loader resolves exactly that file and refuses an unknown version rather than
 * pricing with today's table: a recorded cost keeps the table it was priced
 * with, and a rate change adds a new version file. The ledger reads the row's
 * own amounts; the table here supplies the unit label and the per-unit rate it
 * can show beside a quantity.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { refuse } from "./types";

/** `voni/scripts/lib/usage/` → the repository root, then the pipeline's rates. */
export const RATES_DIR = fileURLToPath(
  new URL("../../../../voice-pipeline/cascade/rates/", import.meta.url),
);

export type VendorRate = {
  readonly key: string;
  readonly leg: string;
  readonly unit: string;
  /** USD per unit, from the table's decimal string. */
  readonly usdPerUnit: number;
  readonly source: string;
  readonly note: string | null;
};

export type RateTable = {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly currency: string;
  readonly date: string;
  readonly rates: ReadonlyMap<string, VendorRate>;
};

const VERSION_ID = /^([A-Za-z0-9][A-Za-z0-9-]*) v(\d+)$/;

/** `cascade-vendor-rates v1` → `{ name, version }`; anything else is refused. */
export function parseRateTableVersion(id: string): { name: string; version: number } {
  const match = VERSION_ID.exec(id.trim());
  if (match === null) {
    refuse(
      "missing-rate-table",
      `"${id}" is not a rate-table version; expected "<name> v<number>", e.g. "cascade-vendor-rates v1"`,
    );
  }
  return { name: match[1] as string, version: Number(match[2]) };
}

function text(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    refuse("missing-rate-table", `${what} has no ${field}`);
  }
  return value.trim();
}

/**
 * Load the table a row cites. A missing file, a name/version drift, a
 * non-USD table or a malformed rate is a named refusal: the ledger cannot
 * price a call with a table it does not hold.
 */
export function loadRateTable(id: string, dir: string = RATES_DIR): RateTable {
  const { name, version } = parseRateTableVersion(id);
  const file = `${dir.replace(/\/$/, "")}/v${version}.json`;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    refuse(
      "missing-rate-table",
      `the committed rate table for "${id}" is missing at ${file}; add the version file rather ` +
        "than pricing the row with another table",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    refuse("missing-rate-table", `${file} is not JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("missing-rate-table", `${file} is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== 1) {
    refuse("missing-rate-table", `${file} has schema ${JSON.stringify(record.schema)}, expected 1`);
  }
  const tableName = text(record, "name", file);
  if (tableName !== name) {
    refuse(
      "missing-rate-table",
      `${file} names the table "${tableName}" but the row cites "${name}"`,
    );
  }
  if (record.version !== version) {
    refuse(
      "missing-rate-table",
      `${file} carries version ${JSON.stringify(record.version)} but the row cites v${version}`,
    );
  }
  const currency = text(record, "currency", file);
  if (currency !== "USD") {
    refuse("missing-rate-table", `${file} is in ${currency}; the ledger reports USD only`);
  }
  const rawRates = record.rates;
  if (typeof rawRates !== "object" || rawRates === null || Array.isArray(rawRates)) {
    refuse("missing-rate-table", `${file} has no rates object`);
  }

  const rates = new Map<string, VendorRate>();
  for (const [key, rawRate] of Object.entries(rawRates as Record<string, unknown>)) {
    if (typeof rawRate !== "object" || rawRate === null || Array.isArray(rawRate)) {
      refuse("missing-rate-table", `${file} rate "${key}" is not an object`);
    }
    const rate = rawRate as Record<string, unknown>;
    const usdText = rate.usd_per_unit;
    const usdPerUnit = typeof usdText === "string" ? Number(usdText) : Number.NaN;
    if (!Number.isFinite(usdPerUnit) || usdPerUnit < 0) {
      refuse(
        "missing-rate-table",
        `${file} rate "${key}" has an invalid usd_per_unit ${JSON.stringify(usdText)}`,
      );
    }
    rates.set(key, {
      key,
      leg: text(rate, "leg", `${file} rate "${key}"`),
      unit: text(rate, "unit", `${file} rate "${key}"`),
      usdPerUnit,
      source: text(rate, "source", `${file} rate "${key}"`),
      note: typeof rate.note === "string" && rate.note.trim() !== "" ? rate.note.trim() : null,
    });
  }
  if (rates.size === 0) refuse("missing-rate-table", `${file} holds no rates`);

  return {
    id: `${name} v${version}`,
    name,
    version,
    currency,
    date: text(record, "date", file),
    rates,
  };
}

/** A row's cited table, loaded once per distinct version. */
export class RateBook {
  readonly #dir: string;
  readonly #loaded = new Map<string, RateTable>();

  constructor(dir: string = RATES_DIR) {
    this.#dir = dir;
  }

  get(id: string): RateTable {
    const cached = this.#loaded.get(id);
    if (cached !== undefined) return cached;
    const table = loadRateTable(id, this.#dir);
    this.#loaded.set(id, table);
    return table;
  }
}
