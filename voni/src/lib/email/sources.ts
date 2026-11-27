/**
 * The schedule and volume domain for the `/email` sources console.
 *
 * Everything the console needs to say "this source clicks *this* often, for
 * *this* long, starting *here*, which is *this* many clicks a day, and right
 * now *these* operating systems are due" lives here once. The card renders it,
 * the aggregate line sums it, and the ticker decides from it — so the number an
 * operator sees and the dispatch that follows cannot disagree.
 *
 * Pure and dependency-free on purpose (no database, no fetch, no `node:*`, no
 * `next/*`): the same module is imported by a client component, a server
 * action and a scheduled handler.
 *
 * Provenance: the existing Grafana volume module (`./volume.ts`) established
 * the shape — plain inputs in, a discriminated result out, refusal sentences
 * pinned by tests. This follows it for the runner-produced source.
 */

/**
 * The intervals a runner source may be set to, in seconds.
 *
 * 15 s is legal because the loop sets the pace, not GitHub's scheduler; 60 min
 * is the cap so a source cannot silently drop below one pass an hour. Anything
 * between two offered values would be a lie about the cadence and is refused
 * by {@link parseInterval}.
 */
export const INTERVAL_SECONDS = [
  15, 30, 60, 120, 300, 600, 900, 1_800, 3_600,
] as const;

export type IntervalSeconds = (typeof INTERVAL_SECONDS)[number];

/**
 * The active-window lengths a runner source may be set to, in seconds: 8, 12
 * or 24 hours. A 12 h default keeps runners off overnight.
 */
export const WINDOW_SECONDS = [28_800, 43_200, 86_400] as const;

export type WindowSeconds = (typeof WINDOW_SECONDS)[number];

/**
 * How long one dispatched job keeps clicking, in seconds.
 *
 * This is not the active window: the window says when the source may run, the
 * segment says how much clicking one runner may do before it ends and is
 * replaced. It is a separate setting because the Tuxler exit pool meters
 * **ten changes per runner** (measured), and a click costs about 1.3 of them —
 * so one job can serve roughly seven clicks, not seven hundred. A job that asks
 * for more spends its budget in the first minute and then tries, and fails, for
 * the rest of its window.
 */
export const SEGMENT_SECONDS = [15, 30, 60, 90, 120, 180, 300, 600, 900] as const;

export type SegmentSeconds = (typeof SEGMENT_SECONDS)[number];

/**
 * How soon a silent runner may be replaced, in seconds.
 *
 * Together with {@link SEGMENT_SECONDS} this is the pace: one OS produces a
 * segment, goes silent, and is re-dispatched after this gap. It is the honest
 * "more clicks / fewer clicks" dial — the window only says how many hours of
 * the day are eligible.
 */
export const RESTART_SECONDS = [15, 30, 60, 120, 180, 300, 600] as const;

export type RestartSeconds = (typeof RESTART_SECONDS)[number];

/** Defaults: one minute of clicking, replaced within a minute. */
export const DEFAULT_SEGMENT_SECONDS = 60;
export const DEFAULT_RESTART_SECONDS = 60;

/**
 * Clicks one runner can actually serve before its Tuxler bucket is spent.
 *
 * Measured, not assumed: a bucket is ten changes, and a click costs ~1.3
 * changes because a good exit is retired on release so the next click gets a
 * different address. Ten ÷ 1.3 ≈ 7.7. The card and the ticker both read this,
 * so the number an operator sees is the number the pool can pay for.
 */
export const CLICKS_PER_SEGMENT_BUDGET = 7;

/**
 * What a runner costs before it clicks anything: checkout, `npm ci`, Chrome,
 * starting the exit pool and waiting for it. Measured on run 45996872962 —
 * 100 s from job start to the first click, 227 s for a 120 s segment.
 *
 * It belongs in the projection because the workflow queues one job per OS: a
 * dispatch every 60 s into a job that takes 160 s does not produce 60-second
 * segments, it produces a queue that falls behind. The cycle is therefore the
 * longer of the pace the operator asked for and the time a job really takes.
 */
export const RUNNER_STARTUP_SECONDS = 100;

/**
 * The operating systems a runner source runs on.
 *
 * This is the same closed set the click intake enforces (`RUNNER_OS_VALUES` in
 * `./click-report.ts`). The copy is deliberate: `click-report` pulls in
 * `node:crypto`, and this module is imported by a client component. A test
 * asserts the two lists stay identical, so the duplication cannot drift.
 */
export const RUNNER_OSES = ["ubuntu", "windows", "macos"] as const;

export type RunnerOs = (typeof RUNNER_OSES)[number];

/**
 * GitHub's hard job ceiling is six hours. A window longer than this is realised
 * as chained segments of at most 20 000 s (~5.6 h), leaving headroom for
 * startup, browser launch and the final report.
 */
export const MAX_JOB_SECONDS = 20_000;

/**
 * The floor under "this OS is dead": a slow single click (the measured worst
 * case is ~45 s while the pool waits for an exit) must not make a healthy
 * runner look gone.
 */
export const MIN_DEAD_AFTER_SECONDS = 60;

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

const INTERVAL_SET: ReadonlySet<number> = new Set(INTERVAL_SECONDS);
const WINDOW_SET: ReadonlySet<number> = new Set(WINDOW_SECONDS);
const SEGMENT_SET: ReadonlySet<number> = new Set(SEGMENT_SECONDS);
const RESTART_SET: ReadonlySet<number> = new Set(RESTART_SECONDS);

/** Why a schedule value was refused. Callers switch on this, never on prose. */
export type ScheduleReason =
  | "unsupported_interval"
  | "unsupported_window"
  | "unsupported_start_hour"
  | "unsupported_segment"
  | "unsupported_restart";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ScheduleReason; reason: string };

/** The one interval sentence an operator ever sees. */
const INTERVAL_REASON =
  "Interval must be 15, 30, 60, 120, 300, 600, 900, 1800 or 3600 seconds.";

const WINDOW_REASON = "Window must be 8, 12 or 24 hours.";

const START_HOUR_REASON =
  "Start hour must be a whole hour from 0 to 23, in UTC.";

const SEGMENT_LENGTH_REASON =
  "One segment may click for 15 seconds to 15 minutes; choose one of the offered lengths.";

const RESTART_REASON =
  "A restart gap may be 15 seconds to 10 minutes; choose one of the offered gaps.";

/**
 * Read a whole number from what a form or the database actually hands over:
 * a number, or the trimmed string a `<select>` sends. Everything else — a
 * fraction, `"60s"`, an empty string, `NaN` — is `null`, so the per-field
 * parser can refuse it with a sentence that names the legal values.
 */
function wholeNumber(input: unknown): number | null {
  if (typeof input === "number") {
    return Number.isSafeInteger(input) ? input : null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The only gate an interval goes through, on save and again when the ticker
 * reads it. `7` is refused because no workflow can pace a loop at 7 s without
 * lying to the operator about clicks per day; `0`, negatives, values above an
 * hour and non-integers are refused for the same reason.
 */
export function parseInterval(input: unknown): ParseResult<IntervalSeconds> {
  const value = wholeNumber(input);
  if (value === null || !INTERVAL_SET.has(value)) {
    return { ok: false, code: "unsupported_interval", reason: INTERVAL_REASON };
  }
  return { ok: true, value: value as IntervalSeconds };
}

/** The only gate a window length goes through; input is seconds. */
export function parseWindowSeconds(input: unknown): ParseResult<WindowSeconds> {
  const value = wholeNumber(input);
  if (value === null || !WINDOW_SET.has(value)) {
    return { ok: false, code: "unsupported_window", reason: WINDOW_REASON };
  }
  return { ok: true, value: value as WindowSeconds };
}

/** The only gate a segment length goes through, on save and again when read. */
export function parseSegmentSeconds(input: unknown): ParseResult<SegmentSeconds> {
  const value = wholeNumber(input);
  if (value === null || !SEGMENT_SET.has(value)) {
    return { ok: false, code: "unsupported_segment", reason: SEGMENT_LENGTH_REASON };
  }
  return { ok: true, value: value as SegmentSeconds };
}

/** The only gate a restart gap goes through. */
export function parseRestartSeconds(input: unknown): ParseResult<RestartSeconds> {
  const value = wholeNumber(input);
  if (value === null || !RESTART_SET.has(value)) {
    return { ok: false, code: "unsupported_restart", reason: RESTART_REASON };
  }
  return { ok: true, value: value as RestartSeconds };
}

/** The only gate the UTC start hour goes through. */
export function parseWindowStartHour(input: unknown): ParseResult<number> {
  const value = wholeNumber(input);
  if (value === null || value < 0 || value >= 24) {
    return {
      ok: false,
      code: "unsupported_start_hour",
      reason: START_HOUR_REASON,
    };
  }
  return { ok: true, value };
}

/**
 * Clicks per day a runner source can actually pay for.
 *
 * The arithmetic is segment-based, not interval-based: a day holds
 * `window / (segment + restart gap)` segments per OS, and each segment is worth
 * {@link clicksPerSegment} clicks (capped by the measured pool budget).
 *
 * Invalid input returns 0 rather than `NaN` or `Infinity`: the card renders
 * this number directly, and a zero an operator can see is wrong beats a
 * nonsense value that looks like a measurement.
 */
export function clicksPerDay(
  intervalSeconds: number,
  windowSeconds: number,
  segmentSeconds: number,
  restartSeconds: number,
  targetCount: number,
  osCount: number,
): number {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return 0;
  if (!Number.isFinite(osCount) || osCount <= 0) return 0;
  // A positive gap is part of the definition, not a default to fall back on: a
  // zero here would mean "restart immediately, forever", which is not a pace.
  if (!Number.isFinite(restartSeconds) || restartSeconds <= 0) return 0;

  const pacedCycle =
    segmentSeconds + deadAfterSeconds(intervalSeconds, restartSeconds);
  const realCycle = RUNNER_STARTUP_SECONDS + segmentSeconds;
  const cycleSeconds = Math.max(pacedCycle, realCycle);
  if (!Number.isFinite(cycleSeconds) || cycleSeconds <= 0) return 0;

  const perSegment = clicksPerSegment(intervalSeconds, segmentSeconds, targetCount);
  if (perSegment <= 0) return 0;

  // One OS runs one segment at a time (the workflow's concurrency group queues,
  // never overlaps), so a day holds `window / cycle` segments per OS.
  return (
    Math.floor(windowSeconds / cycleSeconds) * Math.trunc(osCount) * perSegment
  );
}

/**
 * Clicks one segment asks for, capped by what the exit pool can pay for.
 *
 * Passes tick at `0, interval, 2×interval, …` while the clock is inside the
 * segment, and every pass clicks every target once. The cap is not pessimism:
 * it is the measured ten-change bucket (see
 * {@link CLICKS_PER_SEGMENT_BUDGET}). A card that showed the uncapped product
 * would promise 35 clicks from a job that can afford seven.
 */
export function clicksPerSegment(
  intervalSeconds: number,
  segmentSeconds: number,
  targetCount: number,
): number {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return 0;
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) return 0;
  if (!Number.isFinite(targetCount) || targetCount <= 0) return 0;
  const passes = Math.ceil(segmentSeconds / Math.trunc(intervalSeconds));
  const asked = passes * Math.trunc(targetCount);
  return Math.min(asked, CLICKS_PER_SEGMENT_BUDGET);
}

/**
 * How long an OS may stay silent before the ticker treats it as dead.
 *
 * The operator's restart gap is the pace they asked for; the interval guard
 * stops a slow pass from flapping the same OS, and {@link MIN_DEAD_AFTER_SECONDS}
 * stops a single 45 s click from doing it.
 */
export function deadAfterSeconds(
  intervalSeconds: number,
  restartSeconds = DEFAULT_RESTART_SECONDS,
): number {
  const restart = Number.isFinite(restartSeconds) && restartSeconds > 0
    ? Math.trunc(restartSeconds)
    : DEFAULT_RESTART_SECONDS;
  const interval = Number.isFinite(intervalSeconds) && intervalSeconds > 0
    ? 2 * Math.trunc(intervalSeconds)
    : 0;
  return Math.max(MIN_DEAD_AFTER_SECONDS, restart, interval);
}

function toMs(at: Date | number): number {
  return at instanceof Date ? at.getTime() : at;
}

/** Seconds since UTC midnight, wrapped into `[0, 86_400)`. */
function secondsOfDay(ms: number): number {
  const seconds = Math.floor(ms / 1_000);
  return ((seconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

/** How far into its daily window a moment is, in `[0, 86_400)`. */
function windowOffsetSeconds(
  ms: number,
  startHour: number,
): number {
  const start = startHour * SECONDS_PER_HOUR;
  return ((secondsOfDay(ms) - start) % SECONDS_PER_DAY + SECONDS_PER_DAY) %
    SECONDS_PER_DAY;
}

/**
 * Whether a moment is inside the active window.
 *
 * A window opens at `startHour:00` UTC and lasts `windowSeconds`; a 12 h window
 * opening at 20:00 runs to 08:00 the next morning, so this has to wrap midnight
 * rather than compare two clock times. The end instant is outside — the window
 * is half-open, the same way a segment plan is.
 */
export function insideWindow(
  at: Date | number,
  windowSeconds: number,
  startHour: number,
): boolean {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return false;
  if (!Number.isInteger(startHour) || startHour < 0 || startHour >= 24) {
    return false;
  }
  if (windowSeconds >= SECONDS_PER_DAY) return true;
  return windowOffsetSeconds(toMs(at), startHour) < windowSeconds;
}

/**
 * Seconds left in the open window, or 0 when it is closed. The ticker uses this
 * to clamp the last segment so a job never runs past the window it belongs to.
 */
export function windowRemainingSeconds(
  at: Date | number,
  windowSeconds: number,
  startHour: number,
): number {
  if (!insideWindow(at, windowSeconds, startHour)) return 0;
  const length = Math.min(windowSeconds, SECONDS_PER_DAY);
  return length - windowOffsetSeconds(toMs(at), startHour);
}

export type SegmentPlan =
  | { ok: true; segments: number[] }
  | { ok: false; code: "invalid_duration"; reason: string };

const SEGMENT_REASON =
  "A window plan needs a positive whole number of seconds.";

/**
 * Split a stretch of open window into chained job-sized segments, longest
 * first, with the remainder as a shorter last segment. A 12 h window is
 * `[20 000, 20 000, 3 200]`; the sum is always exactly the window passed in, so
 * a plan can never exceed the time it was given.
 *
 * `seconds` is normally `windowSeconds`, or `windowRemainingSeconds` when a
 * window is already partway through.
 */
export function planSegments(seconds: number): SegmentPlan {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return { ok: false, code: "invalid_duration", reason: SEGMENT_REASON };
  }

  const segments: number[] = [];
  let remaining = seconds;
  while (remaining > 0) {
    const length = Math.min(remaining, MAX_JOB_SECONDS);
    segments.push(length);
    remaining -= length;
  }
  return { ok: true, segments };
}

export type LivenessInput = {
  enabled: boolean;
  intervalSeconds: number;
  windowSeconds: number;
  windowStartHour: number;
  /** How soon a silent OS may be replaced; also the anti-thrash gap. */
  restartSeconds: number;
  now: Date;
  /** When this source last dispatched anything; null if it never has. */
  lastDispatchedAt: Date | null;
  /**
   * The newest click seen per OS. Absent or null means that OS has never
   * reported — the source is dead for it. Clicks are the heartbeat; there is no
   * separate healthy flag to get out of step with them.
   */
  newestClickByOs: Partial<Record<RunnerOs, Date | null>>;
};

/**
 * What the ticker should do this minute, in words rather than a boolean:
 *
 * - `silent` — do nothing; the source is disabled or its window is closed.
 * - `live` — every OS reported recently; nothing to dispatch.
 * - `throttled` — something is dead, but this source dispatched recently
 *   enough that a repeat would be thrash. `resumeInSeconds` is when a dispatch
 *   may be tried again.
 * - `due` — dispatch the named OSes, which are ordered as `RUNNER_OSES`.
 *
 * Order matters: disabled and window first (an automatic recovery must never
 * extend the window), then liveness, then the throttle.
 */
export type DueDecision =
  | { kind: "silent"; reason: "disabled" | "outside_window" }
  | { kind: "live" }
  | { kind: "throttled"; resumeInSeconds: number }
  | { kind: "due"; os: RunnerOs[] };

/**
 * Decide which operating systems need a dispatch right now.
 *
 * An OS is dead once its newest click is at least `deadAfterSeconds(interval)`
 * old — or it never clicked. The comparison is half-open on purpose: a click
 * exactly one threshold ago no longer counts as "within" it.
 */
export function decideDue(input: LivenessInput): DueDecision {
  if (!input.enabled) return { kind: "silent", reason: "disabled" };

  const nowMs = input.now.getTime();
  if (!insideWindow(nowMs, input.windowSeconds, input.windowStartHour)) {
    return { kind: "silent", reason: "outside_window" };
  }

  const threshold = deadAfterSeconds(input.intervalSeconds, input.restartSeconds);
  const due = RUNNER_OSES.filter((os) => {
    const newest = input.newestClickByOs[os];
    if (!newest) return true;
    return (nowMs - newest.getTime()) / 1_000 >= threshold;
  });

  if (due.length === 0) return { kind: "live" };

  // The throttle is the operator's restart gap, not a constant: it is the same
  // number that decides the pace, so the card's projection and the ticker's
  // behaviour cannot disagree. A floor keeps a mis-set 0 from dispatching on
  // every consecutive tick, which would pile up queued runs.
  const gap = Math.max(
    1,
    Number.isFinite(input.restartSeconds) ? Math.trunc(input.restartSeconds) : 1,
  );
  if (input.lastDispatchedAt) {
    const elapsedSeconds = (nowMs - input.lastDispatchedAt.getTime()) / 1_000;
    if (elapsedSeconds < gap) {
      return {
        kind: "throttled",
        resumeInSeconds: Math.ceil(gap - elapsedSeconds),
      };
    }
  }

  return { kind: "due", os: due };
}
