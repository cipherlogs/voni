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
 * A repeat dispatch for the same source is suppressed for this long after the
 * previous one. Without it, a persistent failure would respawn dispatches on
 * every tick; with it, recovery is still bounded at ten minutes.
 */
export const DISPATCH_THROTTLE_SECONDS = 600;

/**
 * An OS is dead once it has produced no click for this floor, even at the
 * fastest interval — a 15 s loop that has been silent for ten minutes is gone.
 */
export const MIN_DEAD_AFTER_SECONDS = 600;

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

const INTERVAL_SET: ReadonlySet<number> = new Set(INTERVAL_SECONDS);
const WINDOW_SET: ReadonlySet<number> = new Set(WINDOW_SECONDS);

/** Why a schedule value was refused. Callers switch on this, never on prose. */
export type ScheduleReason =
  | "unsupported_interval"
  | "unsupported_window"
  | "unsupported_start_hour";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ScheduleReason; reason: string };

/** The one interval sentence an operator ever sees. */
const INTERVAL_REASON =
  "Interval must be 15, 30, 60, 120, 300, 600, 900, 1800 or 3600 seconds.";

const WINDOW_REASON = "Window must be 8, 12 or 24 hours.";

const START_HOUR_REASON =
  "Start hour must be a whole hour from 0 to 23, in UTC.";

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
 * Clicks per day a runner source commands: one pass per interval while the
 * window is open, and every pass clicks every shared target from every OS.
 *
 * So 60 s over 12 h with 4 targets and 3 OSes is `720 × 4 × 3 = 8,640`; the
 * 15 s floor is 34,560; a 24 h window at 60 s is 17,280.
 *
 * Invalid input returns 0 rather than `NaN` or `Infinity`: the card renders
 * this number directly, and a zero an operator can see is wrong beats a
 * nonsense value that looks like a measurement.
 */
export function clicksPerDay(
  intervalSeconds: number,
  windowSeconds: number,
  targetCount: number,
  osCount: number,
): number {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return 0;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return 0;
  if (!Number.isFinite(targetCount) || targetCount <= 0) return 0;
  if (!Number.isFinite(osCount) || osCount <= 0) return 0;
  return Math.floor(
    (windowSeconds / intervalSeconds) * Math.trunc(targetCount) * Math.trunc(osCount),
  );
}

/**
 * How long an OS may stay silent before the ticker treats it as dead: twice the
 * interval, but never less than ten minutes, so the 15 s and 30 s cadences do
 * not flap on a single slow pass.
 */
export function deadAfterSeconds(intervalSeconds: number): number {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return MIN_DEAD_AFTER_SECONDS;
  }
  return Math.max(
    MIN_DEAD_AFTER_SECONDS,
    2 * Math.trunc(intervalSeconds),
  );
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

  const threshold = deadAfterSeconds(input.intervalSeconds);
  const due = RUNNER_OSES.filter((os) => {
    const newest = input.newestClickByOs[os];
    if (!newest) return true;
    return (nowMs - newest.getTime()) / 1_000 >= threshold;
  });

  if (due.length === 0) return { kind: "live" };

  if (input.lastDispatchedAt) {
    const elapsedSeconds = (nowMs - input.lastDispatchedAt.getTime()) / 1_000;
    if (elapsedSeconds < DISPATCH_THROTTLE_SECONDS) {
      return {
        kind: "throttled",
        resumeInSeconds: Math.ceil(DISPATCH_THROTTLE_SECONDS - elapsedSeconds),
      };
    }
  }

  return { kind: "due", os: due };
}
