/**
 * One sanitizer for every machine-readable call event stream.
 *
 * The managed eval stream and the cascade stream share these rules so a
 * careless call site cannot leak a credential or caller audio: forbidden keys
 * are dropped (and reported by name), key-shaped values are redacted in place,
 * and the remaining fields are bounded in depth and length. This module is
 * deliberately free of imports and of stream-specific types so either writer
 * can depend on it.
 */

/** Replacement marker for a key-shaped value. */
export const REDACTED = "[redacted]";

/** Fields that may never appear on a line, whatever the call site passes. */
export const FORBIDDEN_EVENT_KEYS: ReadonlySet<string> = new Set([
  "apikey",
  "api_key",
  "authorization",
  "secret",
  "password",
  "token",
  "accesstoken",
  "access_token",
  "pcm",
  "audio",
  "data",
  "base64",
  "text",
  "transcript",
]);

/** Values shaped like a credential, redacted wherever they appear. */
export const KEY_SHAPED_VALUE = /\b(?:sk|pk|api|tok)_[A-Za-z0-9_-]{8,}\b|Bearer\s+\S+/i;

const KEY_SHAPED_GLOBAL = new RegExp(KEY_SHAPED_VALUE.source, "gi");

/** URL userinfo (`scheme://user:password@host`) carries a credential too. */
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;

/** Redact credentials in one string, keeping the surrounding text readable. */
export function redactKeyShaped(value: string): string {
  return value.replace(URL_CREDENTIAL, `$1${REDACTED}@`).replace(KEY_SHAPED_GLOBAL, REDACTED);
}

export type SanitizedFields = {
  /** True when no forbidden key was present. */
  ok: boolean;
  /** The fields that may be written: forbidden keys removed, values sanitized. */
  value: Record<string, unknown>;
  /** Dotted paths of every forbidden key that was dropped. */
  rejectedKeys: string[];
};

function sanitizeValue(value: unknown, depth: number, path: string[], rejected: string[]): unknown {
  if (depth > 4) return "[depth-limit]";
  if (typeof value === "string") {
    const redacted = redactKeyShaped(value);
    return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, depth + 1, path, rejected));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_EVENT_KEYS.has(key.toLowerCase())) {
        rejected.push([...path, key].join("."));
        continue;
      }
      out[key] = sanitizeValue(entry, depth + 1, [...path, key], rejected);
    }
    return out;
  }
  return String(value);
}

/** Sanitize one line's caller-supplied fields before it is written. */
export function sanitizeEventFields(fields: Record<string, unknown>): SanitizedFields {
  const rejectedKeys: string[] = [];
  const value = sanitizeValue(fields, 0, [], rejectedKeys) as Record<string, unknown>;
  return { ok: rejectedKeys.length === 0, value, rejectedKeys };
}
