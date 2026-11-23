/**
 * Affiliate click history for the `/email` control panel.
 *
 * The panel is a record of what the pool sent and where the visitor landed, not
 * a live view of the target: rows are written once, keyed by nothing but their
 * own id, and never updated. The guard on `target` mirrors the pool's: an
 * absolute http(s) URL or a bug, nothing resolved against an implicit origin.
 */

import { and, avg, count, desc, eq, gte, isNotNull, max } from "drizzle-orm";
import { db } from "@/lib/db";
import { affiliateClicks } from "@/lib/db/schema";
import {
  CLICK_PRODUCERS,
  type ClickProducer,
  type RunnerOs,
} from "@/lib/email/click-report";
import { baseTargetUrl } from "@/lib/email/pool";
import { RUNNER_OSES } from "@/lib/email/sources";

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
  /** Which source produced the click. Every pre-column row is Grafana's. */
  producer: ClickProducer;
  /** The runner OS for a browser producer; null for Grafana and one-off clicks. */
  runnerOs: RunnerOs | null;
  /** The browser pass this click belonged to; null for other producers. */
  passId: string | null;
  ranAt: Date;
};

export type AffiliateClickRow = AffiliateClickReport & { id: string };

export const AFFILIATE_CLICK_DEFAULT_LIMIT = 50;
export const AFFILIATE_CLICK_MAX_LIMIT = 200;
export const AFFILIATE_CLICK_DEFAULT_WINDOW_HOURS = 24;

/**
 * The shared click table's source filter lives in the query string, not in
 * client state: `?source=grafana` is the whole contract, so a copied URL opens
 * the same narrowed table and a reload cannot lose it.
 *
 * `all` is spelled out rather than left implicit so the "All" chip has a link
 * like every other chip; an absent, repeated or unrecognised value resolves to
 * All, never to an error the reader has to decode.
 */
export const CLICK_SOURCE_PARAM = "source";
export const CLICK_SOURCE_ALL = "all";

export type ClickSourceChip = {
  /** The `?source=` value this chip links to. */
  value: string;
  label: string;
  /** The producer the chip narrows to; null for All. */
  producer: ClickProducer | null;
};

const SOURCE_LABELS: Record<ClickProducer, string> = {
  grafana: "Grafana",
  github: "GitHub",
  oneoff: "One-off",
};

export const CLICK_SOURCE_CHIPS: readonly ClickSourceChip[] = [
  { value: CLICK_SOURCE_ALL, label: "All", producer: null },
  ...CLICK_PRODUCERS.map((producer) => ({
    value: producer,
    label: SOURCE_LABELS[producer],
    producer,
  })),
];

/**
 * The producer a `?source=` value selects, or null for All. Accepts what Next
 * hands a page for a repeated parameter and normalises case, so `?source=GitHub`
 * is the GitHub chip rather than a silently empty table.
 */
export function parseClickSource(
  raw: string | string[] | undefined,
): ClickProducer | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return null;
  const value = first.trim().toLowerCase();
  return (
    CLICK_SOURCE_CHIPS.find((chip) => chip.value === value)?.producer ?? null
  );
}

/** A chip as the panel renders it: its link, and whether it is the open view. */
export type ClickSourceChipView = ClickSourceChip & {
  href: string;
  active: boolean;
};

/**
 * The chip row for one resolved filter. Built beside the query, not in the
 * client component, so the link a reader copies and the predicate the server
 * applies come from the same value.
 */
export function clickSourceChips(
  selected: ClickProducer | null,
): ClickSourceChipView[] {
  return CLICK_SOURCE_CHIPS.map((chip) => ({
    ...chip,
    href:
      chip.value === CLICK_SOURCE_ALL
        ? "/email"
        : `/email?${CLICK_SOURCE_PARAM}=${chip.value}`,
    active: chip.producer === selected,
  }));
}

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
    producer: input.producer,
    runnerOs: input.runnerOs,
    passId: input.passId,
    ranAt: input.ranAt,
  });
}

/**
 * One page of click history, newest first. `producer` narrows it to one source;
 * the `(producer, ran_at desc)` index is what serves that without sorting every
 * producer's history.
 *
 * Exported separately from `listAffiliateClicks` so the query can be inspected
 * without a database: a test can prove the predicate and the ordering, which is
 * the observable contract, rather than needing a live Postgres.
 */
export function affiliateClicksPage(
  limit: number = AFFILIATE_CLICK_DEFAULT_LIMIT,
  producer?: ClickProducer,
) {
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
      producer: affiliateClicks.producer,
      runnerOs: affiliateClicks.runnerOs,
      passId: affiliateClicks.passId,
      ranAt: affiliateClicks.ranAt,
    })
    .from(affiliateClicks)
    .where(producer === undefined ? undefined : eq(affiliateClicks.producer, producer))
    .orderBy(desc(affiliateClicks.ranAt))
    .limit(clampClickLimit(limit));
}

export async function listAffiliateClicks(
  limit: number = AFFILIATE_CLICK_DEFAULT_LIMIT,
  producer?: ClickProducer,
): Promise<AffiliateClickRow[]> {
  return affiliateClicksPage(limit, producer);
}

/**
 * The latest visit per target, in epoch milliseconds, for the one-off click's
 * rotate mode: the target whose last visit is oldest goes next, so this is the
 * only history that draw reads.
 *
 * The query groups by the stored string, not by target, because a row holds the
 * URL the visitor was sent to — the pool stamps every one with its provider's
 * `utm_*` params, so a single target appears as one string per provider. Folding
 * each stamped URL through `baseTargetUrl` collapses those back onto the target
 * row's own URL, and keeping the max per base means a target visited from two
 * providers has one entry at its latest visit rather than two entries that
 * would each look never-seen.
 *
 * A group whose max is null is skipped: it is a row with no `ran_at`, which
 * cannot say when that target was last visited. A stored value that is not a
 * date parses to `NaN` and is skipped for the same reason.
 */
export async function lastClickByTargetUrl(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      target: affiliateClicks.target,
      lastAt: max(affiliateClicks.ranAt),
    })
    .from(affiliateClicks)
    .groupBy(affiliateClicks.target);

  const last = new Map<string, number>();
  for (const row of rows) {
    if (row.lastAt === null || row.lastAt === undefined) continue;
    // The HTTP driver returns a timestamp as a string, not a Date; accept both
    // so a driver change cannot silently empty the rotation history.
    const at =
      row.lastAt instanceof Date
        ? row.lastAt.getTime()
        : new Date(String(row.lastAt)).getTime();
    if (!Number.isFinite(at)) continue;

    const base = baseTargetUrl(row.target);
    const seen = last.get(base);
    if (seen === undefined || at > seen) last.set(base, at);
  }
  return last;
}

/**
 * The predicate every stats read shares: the trailing window, narrowed to one
 * producer when the reader asked for one. Exported so the SQL is inspectable
 * without a database — the filter is the observable contract, and a second
 * hand-written `where` in any of the three reads is how the by-status counts
 * would start disagreeing with the total.
 */
export function clickStatsWhere(since: Date, producer?: ClickProducer) {
  const window = gte(affiliateClicks.ranAt, since);
  return producer === undefined
    ? window
    : and(window, eq(affiliateClicks.producer, producer));
}

/**
 * Click totals for a trailing window, optionally for one producer. `now` is a
 * parameter, not `Date.now()`: the panel computes this while rendering, and an
 * unstable clock read is what makes `cacheComponents` refuse to prerender the
 * route. Callers pass the request-time `Date`.
 */
export async function affiliateClickStats(
  windowHours: number = AFFILIATE_CLICK_DEFAULT_WINDOW_HOURS,
  now: Date = new Date(),
  producer?: ClickProducer,
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
  const where = clickStatsWhere(since, producer);

  const [totals] = await db
    .select({ total: count(), avgMs: avg(affiliateClicks.ms) })
    .from(affiliateClicks)
    .where(where);

  // `status` is nullable, so a grouped row is "no status observed", never 0.
  const byStatus = await db
    .select({ status: affiliateClicks.status, count: count() })
    .from(affiliateClicks)
    .where(where)
    .groupBy(affiliateClicks.status)
    .orderBy(desc(count()));

  // Same nullable-row rule as `status`: a bucket with no device is rows written
  // before the pool presented a profile, not an "unknown" device we chose.
  const byDevice = await db
    .select({ device: affiliateClicks.device, count: count() })
    .from(affiliateClicks)
    .where(where)
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

/**
 * One runner-produced click, as the GitHub card reads it.
 *
 * `runnerOs` is nullable because the table allows it (Grafana and one-off rows
 * carry none); the query narrows it out, and the summariser skips a row that
 * somehow arrives without one rather than inventing an OS.
 */
export type RunnerClickSample = {
  runnerOs: RunnerOs | null;
  target: string;
  status: number | null;
  /** The pass this click belonged to; null for rows written before the column. */
  passId: string | null;
  ranAt: Date;
};

/** How one pass measured up, in the card's words. */
export type GithubPassConclusion = "complete" | "partial" | "failed";

/**
 * Coverage of the most recent pass an OS reported — the honest basis for
 * `targets x/x`.
 *
 * A pass is the runner's unit of coverage: every dispatched target, once. A
 * rolling time window cannot answer "did the last sweep cover everything",
 * because a target clicked twenty minutes ago and one clicked seconds ago look
 * the same. Only a row with a status counts as a hit; a report with `status:
 * null` is a click that got no response, which is exactly the miss the number
 * is there to show. The conclusion is stricter than the number: it is complete
 * only when every shared target got a 2xx/3xx, so a sweep that answered 500 on
 * every target still reads `hits = total` but concludes failed.
 */
export type GithubPassCoverage = {
  id: string;
  /** The moment the pass's newest row was recorded. */
  ranAt: Date;
  /** Distinct shared targets this pass landed on with a response. */
  hits: number;
  /** The active shared target count when the summary was built. */
  total: number;
  conclusion: GithubPassConclusion;
};

export type GithubOsStats = {
  os: RunnerOs;
  /** Every click this OS recorded in the window. */
  clicks: number;
  /** Clicks with no response (null) or a non-2xx/3xx status. */
  failed: number;
  /**
   * Distinct shared targets this OS actually landed on, folded by base URL.
   * The card's rolling count; a target removed from the shared list is not
   * counted, so an old click cannot inflate today's coverage.
   */
  targets: string[];
  /** The most recent pass this OS reported, or null when it has none. */
  pass: GithubPassCoverage | null;
};

export type GithubTargetStats = {
  /** Base URL the click landed on, with the provider's `utm_*` stamps folded. */
  target: string;
  clicks: number;
  byOs: Record<RunnerOs, number>;
};

export type GithubClickSummary = {
  total: number;
  byOs: GithubOsStats[];
  byTarget: GithubTargetStats[];
};

/** A fresh per-OS counter for one target row. */
function emptyByOs(): Record<RunnerOs, number> {
  return { ubuntu: 0, windows: 0, macos: 0 };
}

/**
 * Fold the GitHub source's click rows into the two cuts its card shows: by OS
 * (how many clicks, how many failed, which shared targets each landed on) and
 * by target (one row per base URL, split by OS so "macOS never lands on
 * target 3" is visible rather than averaged away).
 *
 * Pure on purpose: the database read is one query, and every count an
 * operator reads is this function, so the card cannot disagree with a test.
 * The `targets` list is the numerator of `targets x/x` and is deliberately
 * limited to the shared list passed in; `byTarget` keeps every clicked base
 * URL, including one later removed from the list, so history stays honest.
 */
export function summariseRunnerClicks(
  rows: readonly RunnerClickSample[],
  sharedTargets: readonly string[],
): GithubClickSummary {
  const shared = new Set(sharedTargets.map((url) => baseTargetUrl(url)));
  const byOs = new Map<
    RunnerOs,
    { clicks: number; failed: number; targets: Set<string> }
  >();
  for (const os of RUNNER_OSES) {
    byOs.set(os, { clicks: 0, failed: 0, targets: new Set<string>() });
  }
  // Per OS, one bucket per pass id: when its newest row landed, which shared
  // targets it hit. Separate from the rolling `targets` set so a pass that
  // recovered a target cannot rewrite the earlier pass's coverage.
  const passesByOs = new Map<
    RunnerOs,
    Map<string, { newestAt: number; hits: Set<string>; succeeded: Set<string> }>
  >();
  for (const os of RUNNER_OSES) passesByOs.set(os, new Map());

  const byTarget = new Map<string, GithubTargetStats>();
  let total = 0;

  for (const row of rows) {
    if (!row.runnerOs) continue;
    const bucket = byOs.get(row.runnerOs);
    // An OS outside the closed allowlist cannot be counted; treating it as a
    // bucket would let a future intake value silently create a fourth column.
    if (!bucket) continue;

    const target = baseTargetUrl(row.target);
    total += 1;
    bucket.clicks += 1;
    if (row.status === null || row.status >= 400) bucket.failed += 1;
    if (shared.has(target)) bucket.targets.add(target);

    if (row.passId) {
      const passes = passesByOs.get(row.runnerOs);
      const pass = passes?.get(row.passId);
      if (passes && pass) {
        pass.newestAt = Math.max(pass.newestAt, row.ranAt.getTime());
        if (row.status !== null && shared.has(target)) pass.hits.add(target);
        if (row.status !== null && row.status < 400 && shared.has(target)) {
          pass.succeeded.add(target);
        }
      } else if (passes) {
        passes.set(row.passId, {
          newestAt: row.ranAt.getTime(),
          hits:
            row.status !== null && shared.has(target)
              ? new Set([target])
              : new Set<string>(),
          succeeded:
            row.status !== null && row.status < 400 && shared.has(target)
              ? new Set([target])
              : new Set<string>(),
        });
      }
    }

    const targetBucket = byTarget.get(target) ?? {
      target,
      clicks: 0,
      byOs: emptyByOs(),
    };
    targetBucket.clicks += 1;
    targetBucket.byOs[row.runnerOs] += 1;
    byTarget.set(target, targetBucket);
  }

  /** The newest pass for one OS, with its hits measured against today's list. */
  function newestPass(os: RunnerOs): GithubPassCoverage | null {
    let newest: {
      id: string;
      newestAt: number;
      hits: Set<string>;
      succeeded: Set<string>;
    } | null = null;
    for (const [id, pass] of passesByOs.get(os) ?? []) {
      if (
        newest === null ||
        pass.newestAt > newest.newestAt ||
        (pass.newestAt === newest.newestAt && id > newest.id)
      ) {
        newest = {
          id,
          newestAt: pass.newestAt,
          hits: pass.hits,
          succeeded: pass.succeeded,
        };
      }
    }
    if (newest === null) return null;

    const hits = newest.hits.size;
    // A hit is any response, including a 500; a pass is only complete when
    // every shared target got a status the runner could treat as delivered
    // (2xx/3xx — the runner follows redirects). Otherwise it is partial when
    // something succeeded and failed when nothing did, so a pass full of 500s
    // cannot read as an unqualified Complete.
    const succeeded = newest.succeeded.size;
    const conclusion: GithubPassConclusion =
      shared.size > 0 && succeeded === shared.size
        ? "complete"
        : succeeded > 0
          ? "partial"
          : "failed";
    return {
      id: newest.id,
      ranAt: new Date(newest.newestAt),
      hits,
      total: shared.size,
      conclusion,
    };
  }

  return {
    total,
    byOs: RUNNER_OSES.map((os) => {
      const bucket = byOs.get(os)!;
      return {
        os,
        clicks: bucket.clicks,
        failed: bucket.failed,
        targets: [...bucket.targets].sort(),
        pass: newestPass(os),
      };
    }),
    // Most-clicked first, target URL as the tie-breaker: stable between renders
    // without relying on the order Postgres happened to return.
    byTarget: [...byTarget.values()].sort(
      (a, b) => b.clicks - a.clicks || a.target.localeCompare(b.target),
    ),
  };
}

/**
 * The GitHub source's rows since a cutoff, newest first. One query, narrowed
 * by the same `(producer, ran_at desc)` index the card and liveness read use;
 * the caller folds it with `summariseRunnerClicks`, so the aggregation is
 * proved without a database.
 */
export function runnerClicksSincePage(producer: ClickProducer, since: Date) {
  return db
    .select({
      runnerOs: affiliateClicks.runnerOs,
      target: affiliateClicks.target,
      status: affiliateClicks.status,
      passId: affiliateClicks.passId,
      ranAt: affiliateClicks.ranAt,
    })
    .from(affiliateClicks)
    .where(
      and(
        eq(affiliateClicks.producer, producer),
        gte(affiliateClicks.ranAt, since),
        isNotNull(affiliateClicks.runnerOs),
      ),
    )
    .orderBy(desc(affiliateClicks.ranAt));
}

export async function runnerClicksSince(
  producer: ClickProducer,
  since: Date,
): Promise<RunnerClickSample[]> {
  return runnerClicksSincePage(producer, since);
}
