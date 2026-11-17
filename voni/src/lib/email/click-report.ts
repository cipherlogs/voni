/**
 * The wire shape one Grafana k6 click reports, parsed once at the edge.
 *
 * The reporter is a check script, not a browser: it holds a shared secret and
 * posts one small JSON object per click. Nothing else in the app reads that
 * shape, so the rules live here as a pure function — the route stays a thin
 * transport, and every rule is testable without a request or a database.
 *
 * Rejections carry a short machine-readable `reason` and never echo the body:
 * the caller is a machine, and a body can contain an arbitrary URL a log
 * reader should not be handed.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { DEVICE_VALUES, type ClickDevice } from "./user-agents";

/** What one visit recorded, in the shape `recordAffiliateClick` takes. */
export type ClickReportInput = {
  target: string;
  source: string | null;
  finalUrl: string | null;
  status: number | null;
  ms: number | null;
  userAgent: string | null;
  device: ClickDevice | null;
  browser: string | null;
  ranAt: Date;
};

export type ClickReportParse =
  | { ok: true; value: ClickReportInput }
  | { ok: false; reason: string };

export const CLICK_REPORT_MAX_TARGET_CHARS = 2048;
export const CLICK_REPORT_MAX_SOURCE_CHARS = 80;
export const CLICK_REPORT_MAX_USER_AGENT_CHARS = 400;
export const CLICK_REPORT_MAX_BROWSER_CHARS = 40;
export const CLICK_REPORT_MAX_MS = 120_000;
/** A report older than this is a retry of stale state, not a click. */
export const CLICK_REPORT_MAX_AGE_MS = 24 * 3_600_000;
/** Clocks disagree a little; more than this is a report from the future. */
export const CLICK_REPORT_MAX_FUTURE_MS = 5 * 60_000;

const MIN_STATUS = 100;
const MAX_STATUS = 599;

type Json = Record<string, unknown>;

function asRecord(raw: unknown): Json | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Json)
    : null;
}

/**
 * The same invariant the table's write holds: an absolute http(s) URL with a
 * host. A relative or `javascript:` value would be stored as a page the pool
 * visited and later render as a working link.
 */
function absoluteHttpUrl(value: string, maxChars: number): string | null {
  if (value.length === 0 || value.length > maxChars) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return value;
}

/** An optional absolute http(s) URL; an empty string means "not observed". */
function optionalUrl(raw: unknown, maxChars: number): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  if (raw.trim() === "") return null;
  return absoluteHttpUrl(raw, maxChars) ?? undefined;
}

function optionalInt(
  raw: unknown,
  min: number,
  max: number,
): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
  if (raw < min || raw > max) return undefined;
  return raw;
}

/**
 * An optional short string (a User-Agent, a browser name). Absent and empty
 * both mean "not observed"; over-long values are refused rather than truncated,
 * because a stored UA that was cut in half is a different claim about the visit
 * than the one the reporter made.
 */
function optionalText(
  raw: unknown,
  maxChars: number,
): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > maxChars) return undefined;
  return trimmed;
}

/**
 * The device class is an enum, not free text: it is what the panel groups on,
 * so a value outside it would create a bucket no filter can ever name. Case is
 * normalized because this field is a classification, not a quoted header.
 */
function optionalDevice(raw: unknown): ClickDevice | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return null;
  return (DEVICE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as ClickDevice)
    : undefined;
}

function parseRanAt(raw: unknown, now: Date): Date | null {
  if (raw === undefined || raw === null) return now;
  if (typeof raw !== "string") return null;
  const ranAt = new Date(raw);
  if (Number.isNaN(ranAt.getTime())) return null;
  const age = now.getTime() - ranAt.getTime();
  if (age > CLICK_REPORT_MAX_AGE_MS) return null;
  if (age < -CLICK_REPORT_MAX_FUTURE_MS) return null;
  return ranAt;
}

export function parseClickReport(raw: unknown, now: Date = new Date()): ClickReportParse {
  const body = asRecord(raw);
  if (!body) return { ok: false, reason: "not_object" };

  const rawTarget = body["target"];
  if (typeof rawTarget !== "string") {
    return { ok: false, reason: "bad_target" };
  }
  const target = absoluteHttpUrl(rawTarget, CLICK_REPORT_MAX_TARGET_CHARS);
  if (!target) return { ok: false, reason: "bad_target" };

  const rawSource = body["source"];
  let source: string | null;
  if (rawSource === undefined || rawSource === null) {
    source = null;
  } else if (typeof rawSource !== "string") {
    return { ok: false, reason: "bad_source" };
  } else {
    const trimmed = rawSource.trim();
    if (trimmed.length > CLICK_REPORT_MAX_SOURCE_CHARS) {
      return { ok: false, reason: "bad_source" };
    }
    source = trimmed.length === 0 ? null : trimmed;
  }

  const finalUrl = optionalUrl(body["finalUrl"], CLICK_REPORT_MAX_TARGET_CHARS);
  if (finalUrl === undefined) return { ok: false, reason: "bad_final_url" };

  const status = optionalInt(body["status"], MIN_STATUS, MAX_STATUS);
  if (status === undefined) return { ok: false, reason: "bad_status" };

  const ms = optionalInt(body["ms"], 0, CLICK_REPORT_MAX_MS);
  if (ms === undefined) return { ok: false, reason: "bad_ms" };

  const userAgent = optionalText(
    body["userAgent"],
    CLICK_REPORT_MAX_USER_AGENT_CHARS,
  );
  if (userAgent === undefined) return { ok: false, reason: "bad_user_agent" };

  const device = optionalDevice(body["device"]);
  if (device === undefined) return { ok: false, reason: "bad_device" };

  const browser = optionalText(body["browser"], CLICK_REPORT_MAX_BROWSER_CHARS);
  if (browser === undefined) return { ok: false, reason: "bad_browser" };

  const ranAt = parseRanAt(body["ranAt"], now);
  if (!ranAt) return { ok: false, reason: "bad_ran_at" };

  // Unknown keys are ignored on purpose: the check script may grow a field
  // before this route knows about it, and an old reporter must keep working.
  return {
    ok: true,
    value: {
      target,
      source,
      finalUrl,
      status,
      ms,
      userAgent,
      device,
      browser,
      ranAt,
    },
  };
}

/**
 * Constant-time check of the shared secret.
 *
 * Both sides are hashed first, so the comparison length is fixed and the number
 * of matching leading characters never influences timing, whatever length the
 * caller sends. A missing header or an unset expected secret is a plain false —
 * there is nothing to compare against, and `false` is what the route answers
 * with either way.
 */
export function isClickReportAuthorized(
  headerValue: string | null,
  expected: string | undefined,
): boolean {
  if (!expected) return false;
  if (!headerValue) return false;

  const given = createHash("sha256").update(headerValue, "utf8").digest();
  const wanted = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(given, wanted);
}
