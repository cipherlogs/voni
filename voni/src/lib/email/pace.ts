/**
 * The pace, expressed as the number the operator actually cares about: clicks
 * per day.
 *
 * The raw settings (passes per runner, restart gap) are what the ticker reads,
 * but nobody thinks "restart gap 120". They think "faster" and "slower", and
 * they want to know what the machine can do at all. This module is the inverse:
 * a target rate in, a reachable pace out, or a plain sentence saying the target
 * is past the ceiling and what the ceiling is.
 *
 * The model is the one `clicksPerDay` uses, solved for the gap instead of
 * evaluated with it:
 *
 *   cycle = dead threshold + runner startup + segment
 *   per day = window / cycle × OSes × clicks per segment
 *
 * A runner holds one job at a time (the workflow's concurrency group queues),
 * so a day is made of cycles, not of intervals.
 */

import {
  CLICKS_PER_SEGMENT_BUDGET,
  RESTART_SECONDS,
  RUNNER_STARTUP_SECONDS,
  clicksPerDay,
  clicksPerSegment,
  deadAfterSeconds,
} from "./sources";

/** The slowest pace the settings offer, and the fastest. */
export type PaceRange = {
  minPerDay: number;
  maxPerDay: number;
};

export type PacePlan = {
  /** What the operator asked for. */
  targetPerDay: number;
  /** What the chosen pace is worth, by the same arithmetic the ticker obeys. */
  projectedPerDay: number;
  /** Within a tenth of the target: close enough that nobody should fiddle. */
  reachable: boolean;
  range: PaceRange;
  passes: number;
  segmentSeconds: number;
  restartSeconds: number;
  /** Plain words when the target cannot be met — null when it can. */
  note: string | null;
};

export type PaceSettings = {
  intervalSeconds: number;
  windowSeconds: number;
  targetCount: number;
  osCount: number;
};

/**
 * Passes one runner should make: as many as fit the exit budget without asking
 * for clicks the pool cannot pay for. Five targets fit one pass (5 ≤ 7); three
 * targets fit two (6 ≤ 7).
 */
export function passesFor(targetCount: number): number {
  if (!Number.isFinite(targetCount) || targetCount <= 0) return 1;
  const passes = Math.floor(CLICKS_PER_SEGMENT_BUDGET / Math.trunc(targetCount));
  return Math.min(6, Math.max(1, passes));
}

function project(settings: PaceSettings, passes: number, restartSeconds: number): number {
  const segmentSeconds = Math.max(1, passes) * settings.intervalSeconds;
  return clicksPerDay(
    settings.intervalSeconds,
    settings.windowSeconds,
    segmentSeconds,
    restartSeconds,
    settings.targetCount,
    settings.osCount,
  );
}

/** The slowest and fastest paces these settings can hold. */
export function paceRange(settings: PaceSettings): PaceRange {
  const passes = passesFor(settings.targetCount);
  return {
    minPerDay: project(settings, passes, RESTART_SECONDS[RESTART_SECONDS.length - 1]!),
    maxPerDay: project(settings, passes, RESTART_SECONDS[0]!),
  };
}

function formatRate(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Turn a target into the nearest pace the settings allow.
 *
 * Close enough counts: the gap is snapped to the offered values, so a target of
 * 3,000 lands on whichever gap projects nearest to it. Out-of-range targets are
 * clamped and said so — a card that quietly projected 7,395 when asked for
 * 20,000 would be lying about the machine.
 */
export function planPace(settings: PaceSettings, targetPerDay: number): PacePlan {
  const passes = passesFor(settings.targetCount);
  const segmentSeconds = passes * settings.intervalSeconds;
  const range = paceRange(settings);

  const target =
    Number.isFinite(targetPerDay) && targetPerDay > 0
      ? Math.trunc(targetPerDay)
      : range.minPerDay;

  // Clamp the target into what is possible, then snap the gap to the offered
  // value that lands nearest.
  const wanted = Math.min(Math.max(target, range.minPerDay), range.maxPerDay);
  let best: number = RESTART_SECONDS[0]!;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const restart of RESTART_SECONDS) {
    const projected = project(settings, passes, restart);
    const distance = Math.abs(projected - wanted);
    if (distance < bestGap) {
      bestGap = distance;
      best = restart;
    }
  }

  const projectedPerDay = project(settings, passes, best);
  const reachable = target >= range.minPerDay
    && target <= range.maxPerDay
    && Math.abs(projectedPerDay - target) <= target * 0.1;

  let note: string | null = null;
  if (target > range.maxPerDay) {
    note =
      `${formatRate(target)}/day is past what ${settings.osCount} runner${settings.osCount === 1 ? "" : "s"} ` +
      `clicking ${settings.targetCount} target${settings.targetCount === 1 ? "" : "s"} can do: the ceiling is ` +
      `${formatRate(range.maxPerDay)}/day, because a runner spends ${RUNNER_STARTUP_SECONDS} s starting up ` +
      `and can pay for about ${CLICKS_PER_SEGMENT_BUDGET} clicks per run. Raising it needs more targets, ` +
      `or more jobs running side by side.`;
  } else if (target < range.minPerDay) {
    note =
      `${formatRate(target)}/day is slower than the slowest setting: ` +
      `${formatRate(range.minPerDay)}/day is the floor, which is one run every ${RESTART_SECONDS[RESTART_SECONDS.length - 1]} s. ` +
      `Pause the source to stop entirely.`;
  } else if (!reachable) {
    note =
      `The offered gaps cannot land exactly on ${formatRate(target)}/day; ` +
      `${formatRate(projectedPerDay)}/day is the nearest.`;
  }

  return {
    targetPerDay: target,
    projectedPerDay,
    reachable,
    range,
    passes,
    segmentSeconds,
    restartSeconds: best,
    note,
  };
}

/**
 * The words for a pace, so the card and a log read the same:
 * "1 pass every 15 s, replaced after 2 min".
 */
export function describePace(plan: PacePlan, intervalSeconds: number): string {
  const pass = plan.passes === 1 ? "1 pass" : `${plan.passes} passes`;
  const gap =
    plan.restartSeconds % 60 === 0
      ? `${plan.restartSeconds / 60} min`
      : `${plan.restartSeconds} s`;
  return `${pass} of ${intervalSeconds} s each, replaced ${gap} after it goes silent`;
}

/** Re-exported so a caller does not have to reach into `sources` for the dead threshold. */
export function paceDeadAfterSeconds(intervalSeconds: number, restartSeconds: number): number {
  return deadAfterSeconds(intervalSeconds, restartSeconds);
}

/** The clicks one runner is paid for at this pace — the number behind the ceiling. */
export function paceClicksPerSegment(settings: PaceSettings, plan: PacePlan): number {
  return clicksPerSegment(settings.intervalSeconds, plan.segmentSeconds, settings.targetCount);
}
