/**
 * The live panel's numbers, proved without a database: the fold is pure, and
 * the read is exercised through injected deps. Every assertion is about what
 * an operator would see — a click with no response is failed, not ok; an OS
 * silent for two days still has an age; the newest pool report wins per OS —
 * rather than about the shape of a drizzle query.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TuxlerPoolReport } from "@/lib/email/pool-report";
import {
  buildLiveSnapshot,
  readLiveSnapshot,
  type LiveSnapshotDeps,
  type LiveSnapshotInput,
  type LiveSourceState,
} from "./live";

const NOW = new Date("2026-11-27T12:00:00.000Z");

/** A click `minutesAgo` before NOW. */
function click(
  minutesAgo: number,
  status: number | null,
  runnerOs: "ubuntu" | "windows" | "macos" | null = "ubuntu",
) {
  return {
    ranAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    status,
    runnerOs,
  };
}

function input(overrides: Partial<LiveSnapshotInput> = {}): LiveSnapshotInput {
  return {
    now: NOW,
    clicks: [],
    failures: [],
    newestByOs: {},
    poolReports: [],
    source: { enabled: true, lastDispatchedAt: null },
    ...overrides,
  };
}

/** The artifact's own shape, with only the fields the panel reads varied. */
function poolReport({
  gateOk = true,
  gateReady = 3,
  minReady = 5,
  finalReady = null as number | null,
  finalOk = false,
}: {
  gateOk?: boolean;
  gateReady?: number;
  minReady?: number;
  finalReady?: number | null;
  finalOk?: boolean;
} = {}): TuxlerPoolReport {
  return {
    enabled: true,
    minReady,
    gate: {
      ok: gateOk,
      reason: gateOk ? null : "short-of-exits",
      detail: null,
      attempts: 1,
      waitedMs: 1_000,
      checkedAt: "2026-11-27T11:55:00.000Z",
      ready: gateReady,
      exits: [],
      refills: 0,
      reconnects: 0,
      lastError: null,
      clientLog: null,
    },
    final:
      finalReady === null
        ? null
        : {
            ok: finalOk,
            error: null,
            checkedAt: "2026-11-27T11:59:00.000Z",
            ready: finalReady,
            exits: [],
            refills: 0,
            reconnects: 0,
            lastError: null,
          },
  };
}

test("now is the injected clock, in ISO", () => {
  const snapshot = buildLiveSnapshot(input());
  assert.equal(snapshot.now, NOW.toISOString());
});

test("a click with no response is failed, a 2xx/3xx is ok, a 4xx/5xx is failed", () => {
  const snapshot = buildLiveSnapshot(
    input({
      clicks: [
        click(1, 200),
        click(2, 399),
        click(3, null),
        click(4, 400),
        click(5, 500),
      ],
    }),
  );

  const five = snapshot.windows.find((window) => window.minutes === 5);
  assert.ok(five);
  assert.deepEqual(five, { minutes: 5, total: 5, ok: 2, failed: 3 });
});

test("the three windows widen from the same rows, and a 25-hour-old click is in none", () => {
  const snapshot = buildLiveSnapshot(
    input({
      clicks: [
        click(1, 200),
        click(7, 500),
        click(30, 302),
        click(90, 200),
        click(1_500, 200),
      ],
    }),
  );

  assert.deepEqual(snapshot.windows, [
    { minutes: 5, total: 1, ok: 1, failed: 0 },
    { minutes: 60, total: 3, ok: 2, failed: 1 },
    { minutes: 1440, total: 4, ok: 3, failed: 1 },
  ]);
});

test("a click exactly at the window edge is inside it", () => {
  const snapshot = buildLiveSnapshot(
    input({ clicks: [click(5, 200), click(5.01, 200)] }),
  );

  const five = snapshot.windows.find((window) => window.minutes === 5);
  assert.equal(five?.total, 1, "the edge is inclusive, one second earlier is not");
});

test("per-OS heartbeat uses the newest click even when it is older than the read window", () => {
  const snapshot = buildLiveSnapshot(
    input({
      clicks: [
        click(10, 200, "ubuntu"),
        click(20, 200, "ubuntu"),
        click(59, 500, "macos"),
      ],
      newestByOs: {
        windows: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000),
        macos: new Date(NOW.getTime() - 59 * 60_000),
      },
    }),
  );

  assert.deepEqual(snapshot.byOs, [
    {
      os: "ubuntu",
      lastClickAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      clicksLastHour: 2,
    },
    {
      os: "windows",
      lastClickAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000).toISOString(),
      clicksLastHour: 0,
    },
    {
      os: "macos",
      lastClickAt: new Date(NOW.getTime() - 59 * 60_000).toISOString(),
      clicksLastHour: 1,
    },
  ]);
});

test("an OS with no click at all has no last click", () => {
  const snapshot = buildLiveSnapshot(input());
  assert.deepEqual(
    snapshot.byOs.map((row) => [row.os, row.lastClickAt]),
    [
      ["ubuntu", null],
      ["windows", null],
      ["macos", null],
    ],
  );
});

test("failures are the top five, most frequent first, stable on ties", () => {
  const snapshot = buildLiveSnapshot(
    input({
      failures: [
        { reason: "quota-spent", count: 3 },
        { reason: "no-us-exit", count: 22 },
        { reason: "not-ready", count: 3 },
        { reason: "relay-silent", count: 9 },
        { reason: "bad-exit", count: 1 },
        { reason: "exit-unavailable", count: 4 },
      ],
    }),
  );

  assert.deepEqual(snapshot.failures, [
    { reason: "no-us-exit", count: 22 },
    { reason: "relay-silent", count: 9 },
    { reason: "exit-unavailable", count: 4 },
    { reason: "not-ready", count: 3 },
    { reason: "quota-spent", count: 3 },
  ]);
});

test("an empty or zero-count failure bucket is not shown", () => {
  const snapshot = buildLiveSnapshot(
    input({
      failures: [
        { reason: "no-us-exit", count: 0 },
        { reason: "   ", count: 4 },
      ],
    }),
  );

  assert.deepEqual(snapshot.failures, []);
});

test("exits prefer the end-of-run observation and carry the pool limit", () => {
  const snapshot = buildLiveSnapshot(
    input({
      poolReports: [
        {
          os: "windows",
          receivedAt: new Date("2026-11-27T11:58:00.000Z"),
          report: poolReport({ gateReady: 2, minReady: 3 }),
        },
        {
          os: "ubuntu",
          receivedAt: new Date("2026-11-27T11:59:00.000Z"),
          report: poolReport({
            gateOk: false,
            gateReady: 1,
            minReady: 5,
            finalReady: 4,
            finalOk: true,
          }),
        },
      ],
    }),
  );

  assert.deepEqual(snapshot.exits, [
    {
      os: "ubuntu",
      receivedAt: "2026-11-27T11:59:00.000Z",
      ok: true,
      ready: 4,
      liveExitLimit: 5,
    },
    {
      os: "windows",
      receivedAt: "2026-11-27T11:58:00.000Z",
      ok: true,
      ready: 2,
      liveExitLimit: 3,
    },
  ]);
});

test("a failed gate is not ok, and an OS outside the allowlist sorts last", () => {
  const snapshot = buildLiveSnapshot(
    input({
      poolReports: [
        {
          os: "linux",
          receivedAt: new Date("2026-11-27T11:59:00.000Z"),
          report: poolReport({ gateOk: false, gateReady: 0 }),
        },
        {
          os: "macos",
          receivedAt: new Date("2026-11-27T11:59:00.000Z"),
          report: poolReport({ gateOk: false, gateReady: 0 }),
        },
      ],
    }),
  );

  assert.deepEqual(
    snapshot.exits.map((row) => [row.os, row.ok, row.ready]),
    [
      ["macos", false, 0],
      ["linux", false, 0],
    ],
  );
});

test("the source row says whether the panel is Off and when it last dispatched", () => {
  const off = buildLiveSnapshot(
    input({ source: { enabled: false, lastDispatchedAt: null } }),
  );
  assert.equal(off.enabled, false);
  assert.equal(off.lastDispatchAt, null);

  const at = new Date("2026-11-27T11:41:00.000Z");
  const on = buildLiveSnapshot(
    input({ source: { enabled: true, lastDispatchedAt: at } }),
  );
  assert.equal(on.enabled, true);
  assert.equal(on.lastDispatchAt, at.toISOString());
});

test("no source row means disabled, never a guessed schedule", () => {
  const snapshot = buildLiveSnapshot(input({ source: null }));
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.lastDispatchAt, null);
});

test("the same input folds to the same JSON", () => {
  const sample = input({
    clicks: [click(1, 200), click(2, null)],
    failures: [{ reason: "no-us-exit", count: 1 }],
    newestByOs: { ubuntu: NOW },
  });

  assert.deepEqual(buildLiveSnapshot(sample), buildLiveSnapshot(sample));
});

/** Complete deps, so a test only states the reads it cares about. */
function deps(overrides: Partial<LiveSnapshotDeps> = {}): LiveSnapshotDeps {
  const base: LiveSnapshotDeps = {
    now: () => NOW,
    readClicks: async () => [],
    readFailures: async () => [],
    readNewestByOs: async () => ({}),
    readPoolReports: async () => [],
    readSource: async () => null,
  };
  return { ...base, ...overrides };
}

test("the read asks for exactly the last 24 hours, once per fact", async () => {
  const calls: { clicks: Date[]; failures: Date[]; newest: number; pools: number; source: number } =
    { clicks: [], failures: [], newest: 0, pools: 0, source: 0 };

  await readLiveSnapshot(
    deps({
      readClicks: async (since) => {
        calls.clicks.push(since);
        return [click(1, 200)];
      },
      readFailures: async (since) => {
        calls.failures.push(since);
        return [{ reason: "no-us-exit", count: 1 }];
      },
      readNewestByOs: async () => {
        calls.newest += 1;
        return { ubuntu: NOW };
      },
      readPoolReports: async () => {
        calls.pools += 1;
        return [];
      },
      readSource: async () => {
        calls.source += 1;
        return { enabled: true, lastDispatchedAt: null };
      },
    }),
  );

  const expected = new Date(NOW.getTime() - 24 * 60 * 60_000);
  assert.deepEqual(calls.clicks, [expected]);
  assert.deepEqual(calls.failures, [expected]);
  assert.deepEqual(
    [calls.newest, calls.pools, calls.source],
    [1, 1, 1],
    "each fact is read once, not once per window",
  );
});

test("the read returns the fold of what it read", async () => {
  const clicks = [click(2, null), click(30, 200)];
  const failures = [{ reason: "no-us-exit", count: 1 }];
  const newestByOs = { ubuntu: NOW };
  const poolReports = [
    {
      os: "ubuntu",
      receivedAt: new Date("2026-11-27T11:58:00.000Z"),
      report: poolReport(),
    },
  ];
  const source: LiveSourceState = {
    enabled: true,
    lastDispatchedAt: new Date("2026-11-27T11:00:00.000Z"),
  };

  const snapshot = await readLiveSnapshot(
    deps({
      readClicks: async () => clicks,
      readFailures: async () => failures,
      readNewestByOs: async () => newestByOs,
      readPoolReports: async () => poolReports,
      readSource: async () => source,
    }),
  );

  assert.deepEqual(
    snapshot,
    buildLiveSnapshot({ now: NOW, clicks, failures, newestByOs, poolReports, source }),
  );
  assert.equal(snapshot.windows[0].failed, 1);
  assert.equal(snapshot.failures[0].reason, "no-us-exit");
  assert.equal(snapshot.lastDispatchAt, "2026-11-27T11:00:00.000Z");
});
