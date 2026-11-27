/**
 * The schedule and volume domain, proved without a database or a dispatch:
 * fixed sets accept exactly what a runner can honour, clicks per day matches
 * the numbers the card prints, a window survives UTC midnight, a long window
 * splits into job-sized segments, and a source's liveness produces a named
 * verdict instead of a boolean.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RUNNER_OS_VALUES } from "./click-report";
import {
  INTERVAL_SECONDS,
  MAX_JOB_SECONDS,
  RUNNER_OSES,
  WINDOW_SECONDS,
  clicksPerDay,
  clicksPerSegment,
  deadAfterSeconds,
  decideDue,
  insideWindow,
  parseInterval,
  parseWindowSeconds,
  parseWindowStartHour,
  planSegments,
  windowRemainingSeconds,
} from "./sources";

const at = (iso: string) => new Date(iso);

test("the fixed sets are the ones the runner honours", () => {
  assert.deepEqual(
    [...INTERVAL_SECONDS],
    [15, 30, 60, 120, 300, 600, 900, 1800, 3600],
  );
  assert.deepEqual([...WINDOW_SECONDS], [28_800, 43_200, 86_400]);
  assert.equal(MAX_JOB_SECONDS, 20_000);
  assert.deepEqual([...RUNNER_OSES], ["ubuntu", "windows", "macos"]);
});

test("the runner OS allowlist agrees with the one the intake enforces", () => {
  assert.deepEqual([...RUNNER_OSES], [...RUNNER_OS_VALUES]);
});

test("parseInterval accepts every offered interval", () => {
  for (const seconds of INTERVAL_SECONDS) {
    const result = parseInterval(seconds);
    assert.equal(result.ok, true, `${seconds} s is offered`);
    if (result.ok) assert.equal(result.value, seconds);
  }
});

test("parseInterval accepts the string a form sends", () => {
  for (const raw of ["15", "60", "3600", " 60 "]) {
    const result = parseInterval(raw);
    assert.equal(result.ok, true, `${JSON.stringify(raw)} is offered`);
    if (result.ok) assert.equal(result.value, Number(raw));
  }
});

test("parseInterval rejects 7, 0, negatives, over an hour, and non-integers", () => {
  for (const bad of [
    7,
    0,
    -60,
    3601,
    45_000,
    1.5,
    "7",
    "abc",
    "",
    "1.5",
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    const result = parseInterval(bad);
    assert.equal(result.ok, false, `${String(bad)} must be refused`);
    if (!result.ok) {
      assert.equal(result.code, "unsupported_interval");
      assert.equal(
        result.reason,
        "Interval must be 15, 30, 60, 120, 300, 600, 900, 1800 or 3600 seconds.",
      );
    }
  }
});

test("parseWindowSeconds accepts 8, 12 and 24 hours only", () => {
  for (const hours of [8, 12, 24]) {
    const result = parseWindowSeconds(hours * 3600);
    assert.equal(result.ok, true, `${hours} h is offered`);
    if (result.ok) assert.equal(result.value, hours * 3600);
  }

  for (const bad of [
    3600,
    6 * 3600,
    48 * 3600,
    0,
    -43_200,
    43_200.5,
    "12",
    "12h",
    null,
    Number.NaN,
  ]) {
    const result = parseWindowSeconds(bad);
    assert.equal(result.ok, false, `${String(bad)} must be refused`);
    if (!result.ok) {
      assert.equal(result.code, "unsupported_window");
      assert.equal(result.reason, "Window must be 8, 12 or 24 hours.");
    }
  }
});

test("parseWindowStartHour accepts 0..23 in UTC", () => {
  for (const hour of [0, 7, 12, 23]) {
    const result = parseWindowStartHour(hour);
    assert.equal(result.ok, true, `${hour}:00 UTC is offered`);
    if (result.ok) assert.equal(result.value, hour);
  }

  for (const bad of [24, -1, 7.5, "07:00", "", null, Number.NaN]) {
    const result = parseWindowStartHour(bad);
    assert.equal(result.ok, false, `${String(bad)} must be refused`);
    if (!result.ok) {
      assert.equal(result.code, "unsupported_start_hour");
      assert.equal(
        result.reason,
        "Start hour must be a whole hour from 0 to 23, in UTC.",
      );
    }
  }
});

test("clicks/day is segments per day, not passes per day", () => {
  // 120 s dead threshold + 100 s runner startup + a 60 s segment is a 280 s
  // cycle: 154 of them in 12 h, four clicks each (one pass over four targets),
  // from three OSes.
  assert.equal(clicksPerDay(60, 43_200, 60, 60, 4, 3), 1_848);
  // The measured shape today: 120 s threshold, 100 s startup, a 15 s pass over
  // five targets is a 235 s cycle, 367 of them in 24 h.
  assert.equal(clicksPerDay(15, 86_400, 15, 120, 5, 3), 5_505);
  // A longer segment adds nothing past the pool budget and lengthens the cycle.
  assert.equal(clicksPerDay(15, 86_400, 300, 60, 5, 3), 3_927);
});

test("clicks/day is zero for input that cannot describe traffic", () => {
  for (const [interval, window, segment, restart, targets, oses] of [
    [0, 43_200, 60, 60, 4, 3],
    [-60, 43_200, 60, 60, 4, 3],
    [Number.NaN, 43_200, 60, 60, 4, 3],
    [60, 0, 60, 60, 4, 3],
    [60, 43_200, 0, 60, 4, 3],
    [60, 43_200, 60, 0, 4, 3],
    [60, 43_200, 60, 60, 0, 3],
    [60, 43_200, 60, 60, 4, 0],
    [60, 43_200, 60, 60, Number.NaN, 3],
  ] as const) {
    assert.equal(clicksPerDay(interval, window, segment, restart, targets, oses), 0);
  }
});

test("insideWindow spans UTC midnight and closes at the end hour", () => {
  // A 12 h window opening at 20:00 UTC runs to 08:00 the next day.
  const window = 12 * 3600;
  const start = 20;

  assert.equal(insideWindow(at("2026-03-04T19:59:59Z"), window, start), false);
  assert.equal(insideWindow(at("2026-03-04T20:00:00Z"), window, start), true);
  assert.equal(insideWindow(at("2026-03-04T23:59:59Z"), window, start), true);
  assert.equal(insideWindow(at("2026-03-05T03:00:00Z"), window, start), true);
  assert.equal(insideWindow(at("2026-03-05T07:59:59Z"), window, start), true);
  assert.equal(insideWindow(at("2026-03-05T08:00:00Z"), window, start), false);
  assert.equal(insideWindow(at("2026-03-05T12:00:00Z"), window, start), false);
});

test("insideWindow: an 8 h window and a 24 h window", () => {
  const eightHours = 8 * 3600;
  assert.equal(insideWindow(at("2026-03-04T07:00:00Z"), eightHours, 7), true);
  assert.equal(insideWindow(at("2026-03-04T14:59:59Z"), eightHours, 7), true);
  assert.equal(insideWindow(at("2026-03-04T15:00:00Z"), eightHours, 7), false);

  // A 24 h window is always open, whatever the start hour.
  for (const iso of [
    "2026-03-04T00:00:00Z",
    "2026-03-04T07:00:00Z",
    "2026-03-04T23:59:59Z",
  ]) {
    assert.equal(insideWindow(at(iso), 86_400, 7), true, iso);
  }
});

test("windowRemainingSeconds counts to the window's end, zero outside", () => {
  const window = 12 * 3600;
  const start = 20;

  assert.equal(windowRemainingSeconds(at("2026-03-04T20:00:00Z"), window, start), 43_200);
  assert.equal(windowRemainingSeconds(at("2026-03-04T21:00:00Z"), window, start), 39_600);
  assert.equal(windowRemainingSeconds(at("2026-03-05T03:00:00Z"), window, start), 18_000);
  assert.equal(windowRemainingSeconds(at("2026-03-05T07:59:59Z"), window, start), 1);
  assert.equal(windowRemainingSeconds(at("2026-03-05T08:00:00Z"), window, start), 0);
  assert.equal(windowRemainingSeconds(at("2026-03-04T12:00:00Z"), window, start), 0);
});

test("a 12 h window splits into job-sized segments, last one shorter", () => {
  const plan = planSegments(43_200);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  assert.deepEqual(plan.segments, [20_000, 20_000, 3_200]);
  assert.equal(
    plan.segments.reduce((sum, seconds) => sum + seconds, 0),
    43_200,
    "the segments never add up to more than the window",
  );
  for (const segment of plan.segments) {
    assert.ok(segment > 0 && segment <= MAX_JOB_SECONDS);
  }
});

test("segments never exceed the window they describe", () => {
  const cases: Array<[window: number, expected: number[]]> = [
    [28_800, [20_000, 8_800]],
    [86_400, [20_000, 20_000, 20_000, 20_000, 6_400]],
    [40_000, [20_000, 20_000]],
    [20_000, [20_000]],
    [3_600, [3_600]],
    [1, [1]],
    // A window shorter than one segment is one short segment, not an error.
    [9_000, [9_000]],
  ];

  for (const [window, expected] of cases) {
    const plan = planSegments(window);
    assert.equal(plan.ok, true, `${window} s plans`);
    if (!plan.ok) continue;
    assert.deepEqual(plan.segments, expected);
    assert.equal(
      plan.segments.reduce((sum, seconds) => sum + seconds, 0),
      window,
    );
    for (const segment of plan.segments) {
      assert.ok(segment > 0 && segment <= MAX_JOB_SECONDS);
    }
  }
});

test("planSegments refuses a duration that is not a positive whole number", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = planSegments(bad);
    assert.equal(plan.ok, false, `${String(bad)} must be refused`);
    if (!plan.ok) assert.equal(plan.code, "invalid_duration");
  }
});

test("deadAfterSeconds is the operator's restart gap, guarded against flapping", () => {
  // The restart gap is the pace the operator asked for...
  assert.equal(deadAfterSeconds(15, 60), 60);
  assert.equal(deadAfterSeconds(15, 300), 300);
  // ...but a slow pass must not make a healthy runner look gone...
  assert.equal(deadAfterSeconds(600, 60), 1_200);
  assert.equal(deadAfterSeconds(3_600, 60), 7_200);
  // ...and a single 45 s click must never do it either.
  assert.equal(deadAfterSeconds(1, 5), 60);
});

test("clicksPerSegment is capped by what the exit pool can pay for", () => {
  // One pass over five targets fits the ten-change bucket with room to spare.
  assert.equal(clicksPerSegment(15, 15, 5), 5);
  // Four passes would ask for 20; the bucket pays for about seven.
  assert.equal(clicksPerSegment(15, 60, 5), 7);
  assert.equal(clicksPerSegment(15, 60, 1), 4);
  // Nothing describable clicks nothing.
  for (const [interval, segment, targets] of [
    [0, 60, 5],
    [15, 0, 5],
    [15, 60, 0],
    [Number.NaN, 60, 5],
  ] as const) {
    assert.equal(clicksPerSegment(interval, segment, targets), 0);
  }
});

/** The shared schedule the card and ticker both read: 60 s, 12 h, 07:00 UTC. */
const schedule = {
  enabled: true,
  intervalSeconds: 60,
  windowSeconds: 43_200,
  windowStartHour: 7,
  // One minute of clicking, one minute to replace the runner: a 2-minute cycle.
  segmentSeconds: 60,
  restartSeconds: 60,
} as const;

test("an OS with no recent click is due; a live one is not", () => {
  const decision = decideDue({
    ...schedule,
    now: at("2026-03-04T09:00:00Z"),
    lastDispatchedAt: null,
    newestClickByOs: {
      ubuntu: at("2026-03-04T08:59:30Z"),
      windows: at("2026-03-04T08:59:45Z"),
      macos: at("2026-03-04T09:00:00Z"),
    },
  });

  assert.equal(decision.kind, "live");

  const partial = decideDue({
    ...schedule,
    now: at("2026-03-04T09:00:00Z"),
    lastDispatchedAt: null,
    newestClickByOs: {
      ubuntu: at("2026-03-04T08:59:30Z"),
      windows: null,
      macos: at("2026-03-04T08:59:45Z"),
    },
  });

  assert.equal(partial.kind, "due");
  if (partial.kind === "due") assert.deepEqual(partial.os, ["windows"]);
});

test("an OS is dead once its newest click is a full threshold old", () => {
  // 60 s interval against a 60 s restart gap: the guard makes the threshold
  // 120 s, so a click 119 s ago is live and one exactly 120 s ago is not.
  const liveAtBoundary = decideDue({
    ...schedule,
    now: at("2026-03-04T09:02:00Z"),
    lastDispatchedAt: null,
    newestClickByOs: {
      ubuntu: at("2026-03-04T09:00:01Z"),
      windows: at("2026-03-04T09:00:01Z"),
      macos: at("2026-03-04T09:00:01Z"),
    },
  });
  assert.equal(liveAtBoundary.kind, "live");

  const deadAtBoundary = decideDue({
    ...schedule,
    now: at("2026-03-04T09:02:00Z"),
    lastDispatchedAt: null,
    newestClickByOs: {
      ubuntu: at("2026-03-04T09:00:00Z"),
      windows: at("2026-03-04T09:00:00Z"),
      macos: at("2026-03-04T09:00:00Z"),
    },
  });
  assert.equal(deadAtBoundary.kind, "due");
  if (deadAtBoundary.kind === "due") {
    assert.deepEqual(deadAtBoundary.os, ["ubuntu", "windows", "macos"]);
  }
});

test("an OS that never clicked is due", () => {
  const decision = decideDue({
    ...schedule,
    now: at("2026-03-04T09:00:00Z"),
    lastDispatchedAt: null,
    newestClickByOs: {},
  });

  assert.equal(decision.kind, "due");
  if (decision.kind === "due") {
    assert.deepEqual(decision.os, ["ubuntu", "windows", "macos"]);
  }
});

test("a disabled source is silent even when every OS is dead", () => {
  const decision = decideDue({
    ...schedule,
    enabled: false,
    now: at("2026-03-04T09:00:00Z"),
    lastDispatchedAt: null,
    newestClickByOs: {},
  });

  assert.equal(decision.kind, "silent");
  if (decision.kind === "silent") assert.equal(decision.reason, "disabled");
});

test("an out-of-window source is silent even when every OS is dead", () => {
  const decision = decideDue({
    ...schedule,
    now: at("2026-03-04T21:00:00Z"),
    lastDispatchedAt: null,
    newestClickByOs: {},
  });

  assert.equal(decision.kind, "silent");
  if (decision.kind === "silent") {
    assert.equal(decision.reason, "outside_window");
  }
});

test("a dead OS is not dispatched twice inside the restart gap", () => {
  const throttled = decideDue({
    ...schedule,
    now: at("2026-03-04T09:00:00Z"),
    lastDispatchedAt: at("2026-03-04T08:59:30Z"),
    newestClickByOs: {},
  });

  assert.equal(throttled.kind, "throttled");
  if (throttled.kind === "throttled") assert.equal(throttled.resumeInSeconds, 30);

  const expired = decideDue({
    ...schedule,
    now: at("2026-03-04T09:00:00Z"),
    lastDispatchedAt: at("2026-03-04T08:59:00Z"),
    newestClickByOs: {},
  });
  assert.equal(expired.kind, "due");
});

test("the throttle does not hide an out-of-window source", () => {
  const decision = decideDue({
    ...schedule,
    now: at("2026-03-04T21:00:00Z"),
    lastDispatchedAt: at("2026-03-04T20:59:30Z"),
    newestClickByOs: {},
  });

  assert.equal(decision.kind, "silent");
  if (decision.kind === "silent") {
    assert.equal(decision.reason, "outside_window");
  }
});
