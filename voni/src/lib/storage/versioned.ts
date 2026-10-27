/**
 * Versioned browser-storage envelope (ticket 07, audit C2).
 *
 * Every stored draft/flag is `{version, data}` JSON. Legacy bare shapes
 * (stored before versioning) are accepted once via `migrateLegacy` and then
 * rewritten versioned on the next write — never silently dropped, never a
 * crash. Unknown future versions fall back to null so new code never reads
 * old code's bytes as truth.
 *
 * Repeated reads are cached within their scope via `createParseCache`:
 * callers memoize by the exact raw string, so a poll that re-reads an
 * unchanged key pays one string compare instead of a JSON.parse.
 */

/** Current envelope version for all client stores. Bump only with a migration. */
export const STORAGE_VERSION = 1;

export type VersionedEnvelope<T> = {
  version: number;
  data: T;
};

/** True for `{version: number, data: unknown}` shapes only. */
export function isVersionedEnvelope(value: unknown): value is VersionedEnvelope<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === "number" && "data" in v;
}

/** Serialize `data` into the minimized `{version, data}` envelope. */
export function wrapVersioned<T>(data: T, version: number = STORAGE_VERSION): string {
  return JSON.stringify({ version, data });
}

export type VersionedParseOptions<T> = {
  /** True when the inner `data` (or legacy bare value) is usable. */
  validate: (data: unknown) => boolean;
  /** Convert a legacy bare payload (or old-envelope data) to the current shape. */
  migrateLegacy?: (legacy: unknown) => T | null;
};

/**
 * Parse one stored raw string. Accepts the current envelope, migrates legacy
 * bare shapes, and returns null for corrupt/foreign/future payloads.
 */
export function parseVersioned<T>(
  raw: string | null,
  opts: VersionedParseOptions<T>,
): T | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (isVersionedEnvelope(parsed)) {
    if (parsed.version === STORAGE_VERSION) {
      if (opts.validate(parsed.data)) return parsed.data as T;
      // Current envelope but unexpected data: try one legacy migration
      // (truncated writes), else safe fallback.
      try {
        return opts.migrateLegacy?.(parsed.data) ?? null;
      } catch {
        return null;
      }
    }
    if (parsed.version < STORAGE_VERSION) {
      try {
        return opts.migrateLegacy?.(parsed.data) ?? null;
      } catch {
        return null;
      }
    }
    // Future version: never interpret unknown bytes.
    return null;
  }
  // Legacy bare shape: validate first, then migrate.
  try {
    if (opts.validate(parsed)) return parsed as T;
    return opts.migrateLegacy?.(parsed) ?? null;
  } catch {
    return null;
  }
}

/**
 * Memoize a `raw -> value` parser by exact raw-string equality.
 * Identical repeats (poll loops, per-render reads) skip re-parsing.
 */
export function createParseCache<T>(parse: (raw: string | null) => T): (raw: string | null) => T {
  let has = false;
  let lastRaw: string | null = null;
  let lastValue: T | undefined;
  return (raw: string | null): T => {
    if (has && raw === lastRaw) return lastValue as T;
    lastValue = parse(raw);
    lastRaw = raw;
    has = true;
    return lastValue as T;
  };
}
