/**
 * Affiliate click history for the `/email` control panel.
 *
 * The panel is a record of what the pool sent and where the visitor landed, not
 * a live view of the target: rows are written once, keyed by nothing but their
 * own id, and never updated. The guard on `target` mirrors the pool's: an
 * absolute http(s) URL or a bug, nothing resolved against an implicit origin.
 */

import { avg, count, desc, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { affiliateClicks } from "@/lib/db/schema";

/** What one visit recorded. `ranAt` is when the edge saw the click, not insert time. */
export type AffiliateClickReport = {
  target: string;
  source: string | null;
  finalUrl: string | null;
  status: number | null;
  ms: number | null;
  /** The identity the visit presented; null for rows that predate the pool. */
  userAgent: string | null;
  device: string | null;
  browser: string | null;
  ranAt: Date;
};

export type AffiliateClickRow = AffiliateClickReport & { id: string };

export const AFFILIATE_CLICK_DEFAULT_LIMIT = 50;
export const AFFILIATE_CLICK_MAX_LIMIT = 200;
export const AFFILIATE_CLICK_DEFAULT_WINDOW_HOURS = 24;

/**
 * The one invariant a write has to hold: `target` is an absolute http(s) URL.
 * A path-only or `javascript:` value would otherwise be stored as if it were a
 * page the pool visited, and later render as a working link in the panel.
 */
export function assertClickTarget(target: string): string {
  let url: URL | null = null;
  try {
    url = new URL(target);
  } catch {
    url = null;
  }
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname
  ) {
    throw new Error(
      `Invalid affiliate click target ${JSON.stringify(target)}: ` +
        "expected an absolute http(s) URL.",
    );
  }
  return target;
}

/**
 * A page size an operator may ask for, bounded to what one request can carry.
 * A non-finite value (`NaN`, either infinity) falls back to the default page
 * rather than becoming an unbounded query; a negative, zero or fractional
 * value clamps into `1..AFFILIATE_CLICK_MAX_LIMIT` with the fraction truncated,
 * so a floor of one row is the only outcome below the default.
 */
export function clampClickLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return AFFILIATE_CLICK_DEFAULT_LIMIT;
  }
  return Math.min(
    AFFILIATE_CLICK_MAX_LIMIT,
    Math.max(1, Math.trunc(limit)),
  );
}

export async function recordAffiliateClick(
  input: AffiliateClickReport,
): Promise<void> {
  assertClickTarget(input.target);
  await db.insert(affiliateClicks).values({
    target: input.target,
    source: input.source,
    finalUrl: input.finalUrl,
    status: input.status,
    ms: input.ms,
    userAgent: input.userAgent,
    device: input.device,
    browser: input.browser,
    ranAt: input.ranAt,
  });
}

export async function listAffiliateClicks(
  limit: number = AFFILIATE_CLICK_DEFAULT_LIMIT,
): Promise<AffiliateClickRow[]> {
  return db
    .select({
      id: affiliateClicks.id,
      target: affiliateClicks.target,
      source: affiliateClicks.source,
      finalUrl: affiliateClicks.finalUrl,
      status: affiliateClicks.status,
      ms: affiliateClicks.ms,
      userAgent: affiliateClicks.userAgent,
      device: affiliateClicks.device,
      browser: affiliateClicks.browser,
      ranAt: affiliateClicks.ranAt,
    })
    .from(affiliateClicks)
    .orderBy(desc(affiliateClicks.ranAt))
    .limit(clampClickLimit(limit));
}

/**
 * Click totals for a trailing window. `now` is a parameter, not `Date.now()`:
 * the panel computes this while rendering, and an unstable clock read is what
 * makes `cacheComponents` refuse to prerender the route. Callers pass the
 * request-time `Date`.
 */
export async function affiliateClickStats(
  windowHours: number = AFFILIATE_CLICK_DEFAULT_WINDOW_HOURS,
  now: Date = new Date(),
): Promise<{
  total: number;
  byStatus: { status: number | null; count: number }[];
  byDevice: { device: string | null; count: number }[];
  avgMs: number | null;
}> {
  // A zero or negative window would mean "since now" and silently report an
  // empty panel; fall back to the window the panel labels instead.
  const hours =
    Number.isFinite(windowHours) && windowHours > 0
      ? windowHours
      : AFFILIATE_CLICK_DEFAULT_WINDOW_HOURS;
  const since = new Date(now.getTime() - hours * 3_600_000);

  const [totals] = await db
    .select({ total: count(), avgMs: avg(affiliateClicks.ms) })
    .from(affiliateClicks)
    .where(gte(affiliateClicks.ranAt, since));

  // `status` is nullable, so a grouped row is "no status observed", never 0.
  const byStatus = await db
    .select({ status: affiliateClicks.status, count: count() })
    .from(affiliateClicks)
    .where(gte(affiliateClicks.ranAt, since))
    .groupBy(affiliateClicks.status)
    .orderBy(desc(count()));

  // Same nullable-row rule as `status`: a bucket with no device is rows written
  // before the pool presented a profile, not an "unknown" device we chose.
  const byDevice = await db
    .select({ device: affiliateClicks.device, count: count() })
    .from(affiliateClicks)
    .where(gte(affiliateClicks.ranAt, since))
    .groupBy(affiliateClicks.device)
    .orderBy(desc(count()));

  const total = Number(totals?.total ?? 0);
  const avgRaw = totals?.avgMs ?? null;

  return {
    total,
    byStatus: byStatus.map((row) => ({
      status: row.status,
      count: Number(row.count),
    })),
    byDevice: byDevice.map((row) => ({
      device: row.device,
      count: Number(row.count),
    })),
    // avg() comes back as a numeric string from Postgres; a null average is
    // "nothing in the window had a measured duration", not zero milliseconds.
    avgMs: avgRaw === null ? null : Math.round(Number(avgRaw)),
  };
}
