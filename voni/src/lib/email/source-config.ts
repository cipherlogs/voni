/**
 * The ticker's database boundary: what a source is configured to do, whether
 * its runners are still clicking, and how a dispatch is recorded.
 *
 * Plain functions and no policy. The decision lives in `./sources`
 * (pure, no database) and the dispatch lives in `@/lib/github/dispatch`, so
 * this module only translates rows to values and back. That keeps the
 * interesting logic testable without Postgres and stops a query change from
 * silently altering what "dead" means.
 *
 * Only sources this app executes itself have a row here; Grafana's schedule
 * stays in Grafana. A producer with no row is not scheduled.
 */

import { and, eq, isNotNull, max } from "drizzle-orm";
import { db } from "@/lib/db";
import { affiliateClicks, emailSources } from "@/lib/db/schema";
import type { ClickProducer, RunnerOs } from "@/lib/email/click-report";

/** The one producer the ticker schedules today. */
export const GITHUB_SOURCE_PRODUCER = "github";

/** Everything the ticker needs from `email_sources`, already typed. */
export type SourceConfig = {
  producer: string;
  enabled: boolean;
  intervalSeconds: number;
  windowSeconds: number;
  windowStartHour: number;
  /** The anti-thrash guard; null when this source never dispatched. */
  lastDispatchedAt: Date | null;
};

/**
 * The source's row, or null when it has none. A missing row is "not
 * scheduled", never an error: it is what a fresh database or a future source
 * that has not been seeded yet looks like.
 */
export async function readSourceConfig(
  producer: string = GITHUB_SOURCE_PRODUCER,
): Promise<SourceConfig | null> {
  const [row] = await db
    .select({
      producer: emailSources.producer,
      enabled: emailSources.enabled,
      intervalSeconds: emailSources.intervalSeconds,
      windowSeconds: emailSources.windowSeconds,
      windowStartHour: emailSources.windowStartHour,
      lastDispatchedAt: emailSources.lastDispatchedAt,
    })
    .from(emailSources)
    .where(eq(emailSources.producer, producer))
    .limit(1);

  return row ?? null;
}

/**
 * The newest click per runner OS — the heartbeat liveness is read from.
 *
 * An OS absent from the result has never reported, which `decideDue` treats as
 * dead. `max()` loses the column's date decoder, so the HTTP driver's string is
 * parsed here; accepting both shapes means a driver change cannot silently
 * make every OS look dead.
 */
export async function newestClickByOs(
  producer: ClickProducer = GITHUB_SOURCE_PRODUCER,
): Promise<Partial<Record<RunnerOs, Date>>> {
  const rows = await db
    .select({
      os: affiliateClicks.runnerOs,
      newest: max(affiliateClicks.ranAt),
    })
    .from(affiliateClicks)
    .where(
      and(
        eq(affiliateClicks.producer, producer),
        isNotNull(affiliateClicks.runnerOs),
      ),
    )
    .groupBy(affiliateClicks.runnerOs);

  const newest: Partial<Record<RunnerOs, Date>> = {};
  for (const row of rows) {
    const os = row.os;
    if (!os || row.newest === null || row.newest === undefined) continue;
    const at =
      row.newest instanceof Date ? row.newest : new Date(String(row.newest));
    if (!Number.isFinite(at.getTime())) continue;
    newest[os] = at;
  }
  return newest;
}

/** The schedule an operator may change; the parser in `./sources` is the gate. */
export type SourceSchedule = {
  intervalSeconds: number;
  windowSeconds: number;
  windowStartHour: number;
};

/**
 * Turn a source on or off. A missing row stays missing: the console says
 * "not configured" instead of pretending a write landed.
 */
export async function setSourceEnabled(
  producer: string,
  enabled: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .update(emailSources)
    .set({ enabled, updatedAt: now })
    .where(eq(emailSources.producer, producer));
}

/**
 * Replace interval, window and start hour in one write, so the ticker can
 * never read a half-applied schedule (a 15 s interval against last week's
 * window).
 */
export async function saveSourceSchedule(
  producer: string,
  schedule: SourceSchedule,
): Promise<void> {
  const now = new Date();
  await db
    .update(emailSources)
    .set({
      intervalSeconds: schedule.intervalSeconds,
      windowSeconds: schedule.windowSeconds,
      windowStartHour: schedule.windowStartHour,
      updatedAt: now,
    })
    .where(eq(emailSources.producer, producer));
}

/**
 * Remember that this source really dispatched at `at`.
 *
 * Only a real dispatch records — a manual fallback (no token) produced no run,
 * so recording it would throttle a retry for a dispatch that never happened.
 */
export async function recordSourceDispatch(
  producer: string,
  at: Date,
): Promise<void> {
  await db
    .update(emailSources)
    .set({ lastDispatchedAt: at, updatedAt: at })
    .where(eq(emailSources.producer, producer));
}
