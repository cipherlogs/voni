/**
 * The browser source's ticker — one cron minute's worth of "does anything need
 * restarting?".
 *
 * Worker-only: the Cloudflare scheduled handler calls this after the job sweep,
 * with the worker secret. It reads config, refuses to act when the source is
 * disabled or its window is closed, and otherwise lets the pure scheduler
 * (`@/lib/email/sources`) name the dead OSes. Clicks are the heartbeat: there
 * is no health flag that could disagree with the rows.
 *
 * Each OS dispatches inside its own try/catch. A GitHub outage, a bad token or
 * a missing target must cost that OS its segment, never the whole sweep — this
 * route is the one path that would otherwise turn a third-party failure into a
 * failed cron.
 *
 * The response is a plain, JSON-safe summary of the decisions and of what
 * happened per OS, so a dry run reads as a log line rather than a mystery.
 */

import { NextResponse } from "next/server";
import { requireWorkerSecret } from "@/lib/jobs/worker-auth";
import {
  dispatchBrowserCheck,
  type DispatchOutcome,
} from "@/lib/github/dispatch";
import {
  GITHUB_SOURCE_PRODUCER,
  newestClickByOs,
  readSourceConfig,
  recordSourceDispatch,
  type SourceConfig,
} from "@/lib/email/source-config";
import {
  MAX_JOB_SECONDS,
  RUNNER_OSES,
  decideDue,
  windowRemainingSeconds,
  type RunnerOs,
} from "@/lib/email/sources";
import type { ClickProducer } from "@/lib/email/click-report";
import { activeTargetUrls } from "@/lib/email/targets";

/** What one OS got this minute. Every shape but `skipped` names a segment. */
export type OsTickOutcome =
  | {
      os: RunnerOs;
      action: "dispatched";
      segmentSeconds: number;
      runUrl: string;
      /** Set when the run was sent but `last_dispatched_at` could not be written. */
      recordError?: string;
    }
  | {
      os: RunnerOs;
      action: "manual";
      segmentSeconds: number;
      command: string;
    }
  | { os: RunnerOs; action: "skipped"; reason: string }
  | {
      os: RunnerOs;
      action: "failed";
      segmentSeconds: number;
      error: string;
    };

/** The dry-run log: decisions in, dispatched/skipped per OS out. */
export type SourceTickSummary = {
  producer: string;
  at: string;
  status: "missing" | "silent" | "live" | "throttled" | "due";
  reason?: "disabled" | "outside_window";
  /** Seconds until anti-thrash lets a dispatch through again. */
  resumeInSeconds?: number;
  intervalSeconds: number | null;
  /** Open window left at `at`; 0 when the window is closed. */
  remainingSeconds: number;
  /** Length of the segment a dispatch in this minute would ask for. */
  segmentSeconds: number;
  os: OsTickOutcome[];
};

/**
 * Every way of doing nothing, in one shape: no dispatch, one skipped line per
 * OS, and the reason a reader needs to see why.
 */
function silentSummary(
  status: Exclude<SourceTickSummary["status"], "due">,
  config: SourceConfig | null,
  at: Date,
  reason: string,
  extra: Partial<
    Pick<
      SourceTickSummary,
      "reason" | "resumeInSeconds" | "remainingSeconds"
    >
  > = {},
): SourceTickSummary {
  return {
    producer: config?.producer ?? GITHUB_SOURCE_PRODUCER,
    at: at.toISOString(),
    status,
    ...extra,
    intervalSeconds: config?.intervalSeconds ?? null,
    remainingSeconds: extra.remainingSeconds ?? 0,
    segmentSeconds: 0,
    os: RUNNER_OSES.map((os) => ({ os, action: "skipped", reason })),
  };
}

/** Injecting these keeps the route test off Postgres, GitHub and the clock. */
export type SourceTickDeps = {
  now?: () => Date;
  readConfig?: (producer: string) => Promise<SourceConfig | null>;
  readNewestClickByOs?: (
    producer: ClickProducer,
  ) => Promise<Partial<Record<RunnerOs, Date>>>;
  readTargets?: () => Promise<string[]>;
  recordDispatch?: (producer: string, at: Date) => Promise<void>;
  dispatch?: (
    input: Parameters<typeof dispatchBrowserCheck>[0],
  ) => Promise<DispatchOutcome>;
};

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * One tick. Exported so the decision and the containment can be proved without
 * a database or a GitHub call; `POST` is the guarded wrapper.
 */
export async function runSourceTick(
  deps: SourceTickDeps = {},
): Promise<SourceTickSummary> {
  const now = deps.now?.() ?? new Date();
  const readConfig = deps.readConfig ?? readSourceConfig;
  const config = await readConfig(GITHUB_SOURCE_PRODUCER);

  if (!config) {
    return silentSummary("missing", null, now, "no_source_config");
  }
  if (!config.enabled) {
    return silentSummary("silent", config, now, "disabled", {
      reason: "disabled",
    });
  }

  const remainingSeconds = windowRemainingSeconds(
    now,
    config.windowSeconds,
    config.windowStartHour,
  );
  if (remainingSeconds <= 0) {
    return silentSummary("silent", config, now, "outside_window", {
      reason: "outside_window",
    });
  }

  const readNewest = deps.readNewestClickByOs ?? newestClickByOs;
  const decision = decideDue({
    enabled: config.enabled,
    intervalSeconds: config.intervalSeconds,
    windowSeconds: config.windowSeconds,
    windowStartHour: config.windowStartHour,
    now,
    lastDispatchedAt: config.lastDispatchedAt,
    newestClickByOs: await readNewest(GITHUB_SOURCE_PRODUCER),
  });

  if (decision.kind === "live") {
    return silentSummary("live", config, now, "clicked_recently", {
      remainingSeconds,
    });
  }
  if (decision.kind === "throttled") {
    return silentSummary("throttled", config, now, "throttled", {
      resumeInSeconds: decision.resumeInSeconds,
      remainingSeconds,
    });
  }
  if (decision.kind === "silent") {
    // decideDue repeats the window check; if it disagrees with the check above,
    // the safe side is still "do not click".
    return silentSummary("silent", config, now, decision.reason, {
      reason: decision.reason,
    });
  }

  const segmentSeconds = Math.min(remainingSeconds, MAX_JOB_SECONDS);
  const readTargets = deps.readTargets ?? activeTargetUrls;
  const targets = await readTargets();

  if (targets.length === 0) {
    return {
      producer: config.producer,
      at: now.toISOString(),
      status: "due",
      intervalSeconds: config.intervalSeconds,
      remainingSeconds,
      segmentSeconds,
      os: RUNNER_OSES.map((os) => ({
        os,
        action: "skipped",
        reason: "no_active_targets",
      })),
    };
  }

  const dispatch = deps.dispatch ?? dispatchBrowserCheck;
  const record = deps.recordDispatch ?? recordSourceDispatch;
  const due: readonly RunnerOs[] = decision.os;
  const os: OsTickOutcome[] = [];

  for (const runnerOs of RUNNER_OSES) {
    if (!due.includes(runnerOs)) {
      os.push({ os: runnerOs, action: "skipped", reason: "clicked_recently" });
      continue;
    }

    try {
      const outcome = await dispatch({
        os: runnerOs,
        targets,
        intervalSeconds: config.intervalSeconds,
        windowSeconds: segmentSeconds,
      });

      if (!outcome.ok) {
        os.push({
          os: runnerOs,
          action: "failed",
          segmentSeconds,
          error: outcome.error,
        });
        continue;
      }

      if (outcome.mode === "manual") {
        // No token: no run started, so nothing is recorded and the next tick
        // may try again.
        os.push({
          os: runnerOs,
          action: "manual",
          segmentSeconds,
          command: outcome.fallback.command,
        });
        continue;
      }

      os.push({
        os: runnerOs,
        action: "dispatched",
        segmentSeconds,
        runUrl: outcome.runUrl,
      });

      try {
        await record(config.producer, now);
      } catch (error) {
        // The run is already queued; failing to remember it only costs an
        // extra attempt after the next liveness check, never this tick.
        const last = os[os.length - 1];
        if (last.action === "dispatched") {
          last.recordError = `The dispatch was sent but not recorded: ${messageOf(error)}`;
        }
      }
    } catch (error) {
      os.push({
        os: runnerOs,
        action: "failed",
        segmentSeconds,
        error: `The browser check could not be dispatched: ${messageOf(error)}`,
      });
    }
  }

  return {
    producer: config.producer,
    at: now.toISOString(),
    status: "due",
    intervalSeconds: config.intervalSeconds,
    remainingSeconds,
    segmentSeconds,
    os,
  };
}

/** Worker-only entry for the one-minute source ticker. */
export async function POST(request: Request) {
  const denied = await requireWorkerSecret(request);
  if (denied) return denied;

  const summary = await runSourceTick();
  return NextResponse.json(summary);
}
