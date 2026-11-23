/**
 * The ticker's contract: a guarded route, a silent source that stays silent,
 * a dead OS that gets one segment, anti-thrash that suppresses a repeat, a
 * manual fallback that records nothing, and an outage that costs one OS and
 * never the sweep.
 *
 * The pure decisions are proved in `@/lib/email/sources.test.ts`; this file
 * pins what the route does with them, at the boundary where a database read and
 * a GitHub call would otherwise be required.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  dispatchBrowserCheck,
  type DispatchOutcome,
} from "@/lib/github/dispatch";
import type { SourceConfig } from "@/lib/email/source-config";
import type { RunnerOs } from "@/lib/email/sources";
import { POST, runSourceTick, type SourceTickDeps } from "./route";

const SOURCE: SourceConfig = {
  producer: "github",
  enabled: true,
  intervalSeconds: 60,
  windowSeconds: 43_200,
  windowStartHour: 7,
  lastDispatchedAt: null,
};

/** Inside the 07:00–19:00 UTC window, at its very start. */
const WINDOW_START = new Date("2026-11-23T07:00:00Z");
/** Inside the window with exactly one hour left. */
const WINDOW_LAST_HOUR = new Date("2026-11-23T18:00:00Z");
/** After the 12 h window that opened at 07:00 has closed. */
const AFTER_WINDOW = new Date("2026-11-23T20:00:00Z");

type Calls = {
  dispatched: { os: RunnerOs; segmentSeconds: number; intervalSeconds: number }[];
  recorded: { producer: string; at: Date }[];
  clickReads: number;
};

function harness(
  overrides: Partial<SourceConfig> | null,
  options: {
    now?: Date;
    clicks?: Partial<Record<RunnerOs, Date>>;
    targets?: string[];
    dispatch?: SourceTickDeps["dispatch"];
    recordDispatch?: SourceTickDeps["recordDispatch"];
  } = {},
): { deps: SourceTickDeps; calls: Calls } {
  const calls: Calls = { dispatched: [], recorded: [], clickReads: 0 };
  const now = options.now ?? WINDOW_START;

  const deps: SourceTickDeps = {
    now: () => now,
    readConfig: async () =>
      overrides === null ? null : { ...SOURCE, ...overrides },
    readNewestClickByOs: async () => {
      calls.clickReads += 1;
      return options.clicks ?? {};
    },
    readTargets: async () => options.targets ?? ["https://example.com/a"],
    dispatch:
      options.dispatch ??
      (async (input) => {
        calls.dispatched.push({
          os: input.os,
          segmentSeconds: input.windowSeconds,
          intervalSeconds: input.intervalSeconds,
        });
        return {
          ok: true,
          mode: "dispatched",
          runUrl: "https://github.com/cipherlogs/voni/actions/workflows/browser-check.yml",
        };
      }),
    recordDispatch:
      options.recordDispatch ??
      (async (producer, at) => {
        calls.recorded.push({ producer, at });
      }),
  };

  return { deps, calls };
}

test("the tick route refuses without the worker secret", async () => {
  const previous = process.env.JOB_WORKER_SECRET;
  process.env.JOB_WORKER_SECRET = "tick-secret";
  try {
    for (const header of [undefined, "wrong", ""]) {
      const response = await POST(
        new Request("http://localhost/api/internal/sources/tick", {
          method: "POST",
          headers: header === undefined ? undefined : { "x-voni-worker-secret": header },
        }),
      );
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "Forbidden." });
    }
  } finally {
    if (previous === undefined) delete process.env.JOB_WORKER_SECRET;
    else process.env.JOB_WORKER_SECRET = previous;
  }
});

test("a source with no row, a disabled source and an out-of-window source dispatch nothing", async () => {
  const cases: {
    label: string;
    overrides: Partial<SourceConfig> | null;
    now?: Date;
    status: string;
    reason?: string;
  }[] = [
    { label: "no row", overrides: null, status: "missing" },
    {
      label: "disabled",
      overrides: { enabled: false },
      status: "silent",
      reason: "disabled",
    },
    {
      label: "after the window",
      overrides: {},
      now: AFTER_WINDOW,
      status: "silent",
      reason: "outside_window",
    },
  ];

  for (const entry of cases) {
    const { deps, calls } = harness(entry.overrides, { now: entry.now });
    const summary = await runSourceTick(deps);

    assert.equal(summary.status, entry.status, entry.label);
    if (entry.reason) assert.equal(summary.reason, entry.reason, entry.label);
    assert.equal(summary.segmentSeconds, 0, entry.label);
    assert.deepEqual(calls.dispatched, [], entry.label);
    assert.deepEqual(calls.recorded, [], entry.label);
    assert.ok(
      summary.os.every((outcome) => outcome.action === "skipped"),
      `${entry.label}: nothing to dispatch`,
    );
  }
});

test("a live source dispatches nothing", async () => {
  const { deps, calls } = harness(
    {},
    {
      clicks: {
        ubuntu: WINDOW_START,
        windows: new Date(WINDOW_START.getTime() - 10_000),
        macos: new Date(WINDOW_START.getTime() - 20_000),
      },
    },
  );

  const summary = await runSourceTick(deps);

  assert.equal(summary.status, "live");
  assert.deepEqual(calls.dispatched, []);
  assert.ok(summary.os.every((outcome) => outcome.action === "skipped"));
});

test("only the dead OS is dispatched, with a job-sized segment, and it is recorded once", async () => {
  const { deps, calls } = harness(
    {},
    {
      clicks: {
        ubuntu: WINDOW_START,
        windows: new Date(WINDOW_START.getTime() - 30_000),
      },
    },
  );

  const summary = await runSourceTick(deps);

  assert.equal(summary.status, "due");
  assert.equal(summary.segmentSeconds, 20_000);
  assert.equal(summary.remainingSeconds, 43_200);
  assert.deepEqual(calls.dispatched, [
    { os: "macos", segmentSeconds: 20_000, intervalSeconds: 60 },
  ]);
  assert.deepEqual(calls.recorded, [{ producer: "github", at: WINDOW_START }]);
  assert.deepEqual(
    summary.os.map((outcome) => [outcome.os, outcome.action]),
    [
      ["ubuntu", "skipped"],
      ["windows", "skipped"],
      ["macos", "dispatched"],
    ],
  );
});

test("anti-thrash suppresses a repeat dispatch and says when it may resume", async () => {
  const now = new Date(WINDOW_START.getTime() + 60_000);
  const { deps, calls } = harness(
    { lastDispatchedAt: WINDOW_START },
    { now },
  );

  const summary = await runSourceTick(deps);

  assert.equal(summary.status, "throttled");
  assert.equal(summary.resumeInSeconds, 540);
  assert.deepEqual(calls.dispatched, []);
  assert.deepEqual(calls.recorded, []);
  assert.ok(summary.os.every((outcome) => outcome.action === "skipped"));
});

test("a segment is the remaining window when that is shorter than the job cap", async () => {
  const { deps, calls } = harness({}, { now: WINDOW_LAST_HOUR });

  const summary = await runSourceTick(deps);

  assert.equal(summary.remainingSeconds, 3_600);
  assert.equal(summary.segmentSeconds, 3_600);
  for (const outcome of summary.os) {
    if (outcome.action !== "dispatched") continue;
    assert.equal(outcome.segmentSeconds, 3_600);
  }
  assert.equal(calls.dispatched.length, 3);
  assert.ok(
    calls.dispatched.every((call) => call.segmentSeconds === 3_600),
    "no dispatch may outlive the open window",
  );
});

test("a manual fallback is not recorded as a dispatched segment", async () => {
  const manual: SourceTickDeps["dispatch"] = async (input) => ({
    ok: true,
    mode: "manual",
    fallback: { command: `gh workflow run browser-check.yml -f os=${input.os}` },
  });
  const { deps, calls } = harness({}, { dispatch: manual });

  const summary = await runSourceTick(deps);

  assert.deepEqual(calls.recorded, []);
  assert.ok(
    summary.os.every((outcome) => outcome.action === "manual"),
    "a missing token is a manual success, per OS",
  );
});

test("a GitHub outage costs one OS and the rest of the tick still runs", async () => {
  const outcomes: Record<RunnerOs, () => Promise<DispatchOutcome>> = {
    ubuntu: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    },
    windows: async () => ({
      ok: true,
      mode: "dispatched",
      runUrl: "https://github.com/cipherlogs/voni/actions/workflows/browser-check.yml",
    }),
    macos: async () => ({ ok: false, error: "GitHub refused the browser check dispatch (403)." }),
  };
  const dispatch: SourceTickDeps["dispatch"] = async (input) => outcomes[input.os]();
  const { deps, calls } = harness({}, { dispatch });

  const summary = await runSourceTick(deps);

  assert.deepEqual(
    summary.os.map((outcome) => [outcome.os, outcome.action]),
    [
      ["ubuntu", "failed"],
      ["windows", "dispatched"],
      ["macos", "failed"],
    ],
  );
  assert.deepEqual(calls.recorded, [{ producer: "github", at: WINDOW_START }]);
  const ubuntu = summary.os[0];
  assert.equal(ubuntu.action, "failed");
  if (ubuntu.action === "failed") {
    assert.match(ubuntu.error, /could not be dispatched/);
  }
});

test("a dispatch that succeeds but cannot be recorded still reports the dispatch", async () => {
  const { deps } = harness(
    {},
    {
      recordDispatch: async () => {
        throw new Error("database unavailable");
      },
    },
  );

  const summary = await runSourceTick(deps);

  assert.equal(summary.status, "due");
  for (const outcome of summary.os) {
    assert.equal(outcome.action, "dispatched");
    if (outcome.action === "dispatched") {
      assert.match(outcome.recordError ?? "", /not recorded/);
    }
  }
});

test("no active target means no dispatch, not a dispatch with an empty list", async () => {
  const { deps, calls } = harness({}, { targets: [] });

  const summary = await runSourceTick(deps);

  assert.equal(summary.status, "due");
  assert.deepEqual(calls.dispatched, []);
  assert.ok(
    summary.os.every(
      (outcome) => outcome.action === "skipped" && outcome.reason === "no_active_targets",
    ),
  );
});

test("the summary is JSON-safe and never carries the dispatch token", async () => {
  const previous = process.env.GITHUB_BURST_TOKEN;
  process.env.GITHUB_BURST_TOKEN = "ghp_tick_secret_token";
  try {
    const dispatch: SourceTickDeps["dispatch"] = async (input) =>
      dispatchBrowserCheck(input, {
        readSecret: async () => process.env.GITHUB_BURST_TOKEN,
        fetcher: async () =>
          new Response("ghp_tick_secret_token is not allowed", { status: 403 }),
      });
    const { deps } = harness({}, { dispatch });

    const summary = await runSourceTick(deps);
    const serialized = JSON.stringify(summary);

    assert.ok(serialized.length > 0);
    assert.ok(!serialized.includes("ghp_tick_secret_token"), serialized);
    assert.ok(
      summary.os.every((outcome) => outcome.action === "failed"),
      "a refused credential is an error, not a silent success",
    );
  } finally {
    if (previous === undefined) delete process.env.GITHUB_BURST_TOKEN;
    else process.env.GITHUB_BURST_TOKEN = previous;
  }
});

test("the worker ticks the source after the sweep and contains a ticker failure", () => {
  const worker = readFileSync(
    fileURLToPath(new URL("../../../../../../worker.ts", import.meta.url)),
    "utf8",
  );
  const scheduled = worker.slice(worker.indexOf("async scheduled"));
  const sweepAt = scheduled.indexOf('/api/internal/jobs/sweep');
  const tickAt = scheduled.indexOf('/api/internal/sources/tick');

  assert.notEqual(sweepAt, -1, "the scheduled handler still calls the sweep");
  assert.notEqual(tickAt, -1, "the scheduled handler calls the source ticker");
  assert.ok(sweepAt < tickAt, "the sweep runs first; the ticker is subordinate");

  const between = scheduled.slice(sweepAt, tickAt);
  assert.match(between, /try\s*{/, "the ticker call is inside a try/catch");
  assert.match(
    scheduled.slice(tickAt),
    /catch\s*\(\s*error\s*\)\s*{[\s\S]*console\.error/,
    "a ticker failure is logged, not rethrown",
  );
});
