/**
 * The `/email` live panel's data boundary: what the click pipeline is doing
 * right now, folded from one bounded read per fact.
 *
 * Same separation as `./source-config`: this module translates rows to values
 * and folds them, and the interesting rules — what a window counts, whether a
 * status is `ok` or `failed`, which pool observation is current — live in the
 * pure `buildLiveSnapshot`. That keeps every number an operator reads testable
 * without Postgres, and the polling route a thin transport.
 *
 * The panel watches the producer the ticker actually runs (`github`); Grafana's
 * schedule and one-off clicks stay out of every count, because a click from
 * another producer landing in the same five minutes would otherwise read as
 * "the runners are alive" when they are not.
 *
 * `status` is the whole point of the split: a click with no response is stored
 * with a null status and a `failure_reason`, and it must not hide inside the
 * total. `ok` is a 2xx/3xx (the browser followed redirects); `failed` is no
 * response at all or a 4xx/5xx. A 1xx is not a final page, so it is counted in
 * the total and in neither split.
 */

import { and, asc, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { affiliateClicks, tuxlerPoolReports } from "@/lib/db/schema";
import type { RunnerOs } from "@/lib/email/click-report";
import {
  POOL_REPORT_PRODUCER,
  type TuxlerPoolReport,
} from "@/lib/email/pool-report";
import {
  GITHUB_SOURCE_PRODUCER,
  newestClickByOs,
  readSourceConfig,
} from "@/lib/email/source-config";
import { RUNNER_OSES } from "@/lib/email/sources";

/** The three windows the panel states, largest last. */
export const LIVE_WINDOW_MINUTES = [5, 60, 1440] as const;
export type LiveWindowMinutes = (typeof LIVE_WINDOW_MINUTES)[number];

/** The largest window is also the read: one query serves all three cuts. */
export const LIVE_READ_WINDOW_MINUTES: LiveWindowMinutes = 1440;

/** "Top failures" is a short list, not a log. */
export const LIVE_FAILURE_LIMIT = 5;

/** What the route and the panel exchange; nothing here needs re-hydrating. */
export type LiveSnapshot = {
  now: string;
  windows: {
    minutes: 5 | 60 | 1440;
    total: number;
    ok: number;
    failed: number;
  }[];
  byOs: {
    os: "ubuntu" | "windows" | "macos";
    lastClickAt: string | null;
    clicksLastHour: number;
  }[];
  failures: { reason: string; count: number }[];
  exits: {
    os: string;
    receivedAt: string;
    ok: boolean;
    ready: number;
    liveExitLimit: number;
  }[];
  lastDispatchAt: string | null;
  enabled: boolean;
};

/** One click row, reduced to what the fold asks of it. */
export type LiveClickSample = {
  ranAt: Date;
  status: number | null;
  runnerOs: RunnerOs | null;
};

/** One grouped failure bucket from the last 24 h. */
export type LiveFailureCount = { reason: string; count: number };

/** The newest stored pool report for one OS, already parsed at intake. */
export type LivePoolReportRow = {
  os: string;
  receivedAt: Date;
  report: TuxlerPoolReport;
};

/** The `email_sources` facts the panel needs; null when no row exists. */
export type LiveSourceState = {
  enabled: boolean;
  lastDispatchedAt: Date | null;
};

/** Everything the pure fold needs, with dates already decoded. */
export type LiveSnapshotInput = {
  now: Date;
  /** This producer's clicks in the last 24 h, newest first or not. */
  clicks: readonly LiveClickSample[];
  /** Grouped `failure_reason` counts for the same window. */
  failures: readonly LiveFailureCount[];
  /** The all-time newest click per OS, so a >24 h silence reads as an age. */
  newestByOs: Partial<Record<RunnerOs, Date>>;
  /** One row per OS: the table is upserted, so this is already the newest. */
  poolReports: readonly LivePoolReportRow[];
  source: LiveSourceState | null;
};

/** A successful click is any response the browser could land on. */
function isOk(status: number | null): boolean {
  return status !== null && status >= 200 && status <= 399;
}

/**
 * A failure is *no response* or an error response. The null case is the one
 * worth keeping explicit: it is what a pool refusal looks like.
 */
function isFailed(status: number | null): boolean {
  return status === null || status >= 400;
}

/** A timestamp as ISO, or null when absent/unreadable. */
function isoAt(at: Date | string | null | undefined): string | null {
  if (at === null || at === undefined) return null;
  const date = at instanceof Date ? at : new Date(at);
  const ms = date.getTime();
  return Number.isFinite(ms) ? date.toISOString() : null;
}

/** A timestamp in epoch ms, or null when absent/unreadable. */
function msAt(at: Date | string | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Sort key: the table's OS order first, anything unexpected after it. */
function osRank(os: string): number {
  const index = (RUNNER_OSES as readonly string[]).indexOf(os);
  return index === -1 ? RUNNER_OSES.length : index;
}

/**
 * Fold raw rows into the one snapshot the panel renders.
 *
 * Pure and clock-free: `now` is an input, every age and window is relative to
 * it, and two calls with the same input produce the same JSON. That is what
 * lets the panel derive ages from `snapshot.now` instead of reading a fresh
 * `Date` during render.
 */
export function buildLiveSnapshot(input: LiveSnapshotInput): LiveSnapshot {
  const nowMs = input.now.getTime();
  const now = input.now.toISOString();

  const windows = LIVE_WINDOW_MINUTES.map((minutes) => {
    const from = nowMs - minutes * 60_000;
    let total = 0;
    let ok = 0;
    let failed = 0;
    for (const click of input.clicks) {
      const at = msAt(click.ranAt);
      // A click the driver could not decode cannot be placed in any window.
      if (at === null || at < from) continue;
      total += 1;
      if (isOk(click.status)) ok += 1;
      else if (isFailed(click.status)) failed += 1;
    }
    return { minutes, total, ok, failed };
  });

  const hourAgo = nowMs - 60 * 60_000;
  const byOs = RUNNER_OSES.map((os) => {
    let newest = msAt(input.newestByOs[os]);
    let clicksLastHour = 0;
    for (const click of input.clicks) {
      if (click.runnerOs !== os) continue;
      const at = msAt(click.ranAt);
      if (at === null) continue;
      if (newest === null || at > newest) newest = at;
      if (at >= hourAgo) clicksLastHour += 1;
    }
    return {
      os,
      lastClickAt: newest === null ? null : new Date(newest).toISOString(),
      clicksLastHour,
    };
  });

  // Most frequent first, reason as the tie-break: stable between polls without
  // depending on the order Postgres returned.
  const failures = [...input.failures]
    .filter((row) => row.reason.trim() !== "" && row.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, LIVE_FAILURE_LIMIT)
    .map((row) => ({ reason: row.reason, count: row.count }));

  const exits = [...input.poolReports]
    .map((row) => {
      const gate = row.report.gate;
      // The artifact writes `gate` before the clicks and `final` after them;
      // a failed final read is not an observation, so the gate half answers.
      const final =
        row.report.final !== null && row.report.final.ok
          ? row.report.final
          : null;
      return {
        os: row.os,
        receivedAt: isoAt(row.receivedAt) ?? now,
        ok: final !== null || gate.ok,
        ready: final?.ready ?? gate.ready,
        liveExitLimit: row.report.minReady,
      };
    })
    .sort((a, b) => osRank(a.os) - osRank(b.os) || a.os.localeCompare(b.os));

  return {
    now,
    windows,
    byOs,
    failures,
    exits,
    lastDispatchAt: isoAt(input.source?.lastDispatchedAt ?? null),
    enabled: input.source?.enabled ?? false,
  };
}

/** One query, three windows: this producer's clicks across the largest one. */
function liveClicksQuery(since: Date) {
  return db
    .select({
      ranAt: affiliateClicks.ranAt,
      status: affiliateClicks.status,
      runnerOs: affiliateClicks.runnerOs,
    })
    .from(affiliateClicks)
    .where(
      and(
        eq(affiliateClicks.producer, GITHUB_SOURCE_PRODUCER),
        gte(affiliateClicks.ranAt, since),
      ),
    )
    .orderBy(desc(affiliateClicks.ranAt));
}

/**
 * Failure reasons in the same window, already grouped. Only rows that carry a
 * reason can be grouped — a 500 with `failure_reason = null` is a failed
 * response, not a pool refusal, and it is not claimed as one.
 */
function liveFailuresQuery(since: Date) {
  return db
    .select({
      reason: affiliateClicks.failureReason,
      count: count(),
    })
    .from(affiliateClicks)
    .where(
      and(
        eq(affiliateClicks.producer, GITHUB_SOURCE_PRODUCER),
        gte(affiliateClicks.ranAt, since),
        isNotNull(affiliateClicks.failureReason),
      ),
    )
    .groupBy(affiliateClicks.failureReason)
    .orderBy(desc(count()), asc(affiliateClicks.failureReason))
    .limit(LIVE_FAILURE_LIMIT);
}

/** The table is upserted per `(producer, runner_os)`, so no grouping needed. */
function livePoolReportsQuery() {
  return db
    .select({
      os: tuxlerPoolReports.runnerOs,
      receivedAt: tuxlerPoolReports.receivedAt,
      report: tuxlerPoolReports.report,
    })
    .from(tuxlerPoolReports)
    .where(eq(tuxlerPoolReports.producer, POOL_REPORT_PRODUCER));
}

/**
 * The reads, as one object so a test can substitute every one of them and the
 * route never sees a query. Same shape as `PoolReportStore`.
 */
export type LiveSnapshotDeps = {
  now: () => Date;
  readClicks: (since: Date) => Promise<LiveClickSample[]>;
  readFailures: (since: Date) => Promise<LiveFailureCount[]>;
  readNewestByOs: () => Promise<Partial<Record<RunnerOs, Date>>>;
  readPoolReports: () => Promise<LivePoolReportRow[]>;
  readSource: () => Promise<LiveSourceState | null>;
};

const databaseDeps: LiveSnapshotDeps = {
  now: () => new Date(),
  async readClicks(since) {
    return liveClicksQuery(since);
  },
  async readFailures(since) {
    const rows = await liveFailuresQuery(since);
    return rows.flatMap((row) =>
      row.reason === null
        ? []
        : [{ reason: row.reason, count: Number(row.count) }],
    );
  },
  readNewestByOs: () => newestClickByOs(),
  async readPoolReports() {
    return livePoolReportsQuery();
  },
  async readSource() {
    const config = await readSourceConfig();
    if (config === null) return null;
    return {
      enabled: config.enabled,
      lastDispatchedAt: config.lastDispatchedAt,
    };
  },
};

let currentDeps: LiveSnapshotDeps = databaseDeps;

/**
 * Replace the reads. Production never calls this; the route test does, so the
 * gate and the JSON shape are exercised without a database. Omit the argument
 * to restore the real reads.
 */
export function setLiveSnapshotDeps(deps?: LiveSnapshotDeps): void {
  currentDeps = deps ?? databaseDeps;
}

/**
 * Read every fact once, in parallel, and fold it. The window is anchored on the
 * injected clock (not `Date.now()`), so the snapshot and its ages agree.
 */
export async function readLiveSnapshot(
  deps: LiveSnapshotDeps = currentDeps,
): Promise<LiveSnapshot> {
  const now = deps.now();
  const since = new Date(
    now.getTime() - LIVE_READ_WINDOW_MINUTES * 60_000,
  );

  const [clicks, failures, newestByOs, poolReports, source] =
    await Promise.all([
      deps.readClicks(since),
      deps.readFailures(since),
      deps.readNewestByOs(),
      deps.readPoolReports(),
      deps.readSource(),
    ]);

  return buildLiveSnapshot({
    now,
    clicks,
    failures,
    newestByOs,
    poolReports,
    source,
  });
}
