/**
 * The cancel half of a Restart, proved without GitHub.
 *
 * What these pin: only the named OS's active runs are found and cancelled; a
 * cancellation is not "done" until a read says so; the wait is bounded and
 * says what is still running; and no refusal — missing token, 401, 403, a
 * runner that ignores the cancel — turns into a string that contains the
 * token. A restart must never dispatch on the strength of a cancel *request*,
 * only on an observed stop.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_CHECK_WORKFLOW_FILE,
  CANCEL_POLL_INTERVAL_MS,
  CANCEL_TIMEOUT_MS,
  CANCEL_WAIT_TIMEOUT_MS,
  browserCheckRunName,
  cancelBrowserCheckRuns,
} from "./dispatch";
import type { RunnerOs } from "@/lib/email/click-report";

const TOKEN = "ghp_cancelsecretvalue789";
const REPO = "cipherlogs/voni";

type FakeRun = {
  id: number;
  status: string;
  display_title: string;
};

type Call = { method: string; path: string; init: RequestInit | undefined };

/**
 * A GitHub that keeps runs in memory. `pollsBeforeDone` is how many reads of a
 * run it answers `in_progress` before reporting `completed`; `null` means it
 * never finishes. `cancelStatus` lets one refusal be exercised.
 */
function fakeGithub(options: {
  runs?: FakeRun[];
  pollsBeforeDone?: number | null;
  listStatus?: number;
  cancelStatus?: number;
}) {
  const calls: Call[] = [];
  const runs = (options.runs ?? []).map((run) => ({ ...run }));
  const polls = new Map<number, number>();
  const events: string[] = [];

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search, init });

    if (method === "GET" && url.pathname.endsWith("/runs")) {
      if (options.listStatus && options.listStatus !== 200) {
        return new Response(JSON.stringify({ message: `list ${options.listStatus}` }), {
          status: options.listStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const cancel = /\/actions\/runs\/(\d+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && cancel) {
      events.push(`cancel:${cancel[1]}`);
      if (options.cancelStatus && options.cancelStatus !== 202) {
        return new Response(null, { status: options.cancelStatus });
      }
      const run = runs.find((entry) => entry.id === Number(cancel[1]));
      if (run) run.status = "cancelling";
      return new Response(null, { status: 202 });
    }

    const poll = /\/actions\/runs\/(\d+)$/.exec(url.pathname);
    if (method === "GET" && poll) {
      events.push(`poll:${poll[1]}`);
      const run = runs.find((entry) => entry.id === Number(poll[1]));
      if (!run) return new Response(null, { status: 404 });
      const seen = (polls.get(run.id) ?? 0) + 1;
      polls.set(run.id, seen);
      const done =
        options.pollsBeforeDone !== null &&
        options.pollsBeforeDone !== undefined &&
        seen >= options.pollsBeforeDone;
      const status = done ? "completed" : run.status;
      return new Response(JSON.stringify({ id: run.id, status }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(null, { status: 500 });
  }) as unknown as typeof fetch;

  return { fetcher, calls, runs, events };
}

/** No test waits on a timer; the bound is proved by the number of sleeps. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const UBUNTU = browserCheckRunName("ubuntu");
const WINDOWS = browserCheckRunName("windows");

test("the run name is the one the workflow prints, per OS", () => {
  assert.equal(UBUNTU, "Browser check (ubuntu)");
  assert.deepEqual(
    (["ubuntu", "windows", "macos"] as RunnerOs[]).map(browserCheckRunName),
    ["Browser check (ubuntu)", "Browser check (windows)", "Browser check (macos)"],
  );
});

test("the wait is bounded and the interval is a small fraction of it", () => {
  assert.equal(CANCEL_TIMEOUT_MS, 10_000);
  assert.ok(CANCEL_WAIT_TIMEOUT_MS > 0, "the wait must have a ceiling");
  assert.ok(
    CANCEL_POLL_INTERVAL_MS > 0 &&
      CANCEL_POLL_INTERVAL_MS < CANCEL_WAIT_TIMEOUT_MS,
    "a poll interval that exceeds the bound would never observe a stop",
  );
});

test("nothing running: no cancel request and no wait", async () => {
  const { fetcher, calls } = fakeGithub({
    runs: [{ id: 3, status: "completed", display_title: UBUNTU }],
  });
  const { waits, sleep } = fakeSleep();

  const result = await cancelBrowserCheckRuns("ubuntu", {
    fetcher,
    sleep,
    readSecret: async () => TOKEN,
  });

  assert.deepEqual(result, { ok: true, cancelled: false, runIds: [] });
  assert.equal(waits.length, 0, "an idle OS costs no polling");
  assert.equal(
    calls.filter((call) => call.method === "POST").length,
    0,
    "there was nothing to cancel",
  );
});

test("only the named OS's active runs are cancelled, and the stop is observed", async () => {
  const { fetcher, calls, runs, events } = fakeGithub({
    runs: [
      { id: 11, status: "in_progress", display_title: UBUNTU },
      { id: 12, status: "queued", display_title: UBUNTU },
      { id: 13, status: "in_progress", display_title: WINDOWS },
    ],
    pollsBeforeDone: 2,
  });
  const { waits, sleep } = fakeSleep();

  const result = await cancelBrowserCheckRuns("ubuntu", {
    fetcher,
    sleep,
    readSecret: async () => TOKEN,
  });

  assert.deepEqual(result, { ok: true, cancelled: true, runIds: [11, 12] });

  const cancelled = calls
    .filter((call) => call.method === "POST")
    .map((call) => call.path)
    .sort();
  assert.deepEqual(cancelled, [
    `/repos/${REPO}/actions/runs/11/cancel`,
    `/repos/${REPO}/actions/runs/12/cancel`,
  ]);
  assert.equal(
    calls.some((call) => call.path.includes("/runs/13/")),
    false,
    "another OS's run is never touched",
  );

  // Neither run is reported stopped until a read says so, and the wait ends as
  // soon as both are complete.
  assert.ok(
    events.indexOf("poll:11") > events.indexOf("cancel:11"),
    "the first observation follows the cancel request",
  );
  assert.equal(waits.length, 1, "one round of both runs was still active, then both stopped");
  assert.equal(
    runs.find((run) => run.id === 13)?.status,
    "in_progress",
    "the other OS keeps clicking",
  );
});

test("a queued run counts: cancelling only the in-progress one would let it start", async () => {
  const { fetcher, calls } = fakeGithub({
    runs: [
      { id: 21, status: "in_progress", display_title: UBUNTU },
      { id: 22, status: "queued", display_title: UBUNTU },
    ],
    pollsBeforeDone: 1,
  });

  const result = await cancelBrowserCheckRuns("ubuntu", {
    fetcher,
    sleep: async () => {},
    readSecret: async () => TOKEN,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls
      .filter((call) => call.method === "POST")
      .map((call) => call.path)
      .sort(),
    [
      `/repos/${REPO}/actions/runs/21/cancel`,
      `/repos/${REPO}/actions/runs/22/cancel`,
    ],
  );
});

test("a runner that never stops is reported, bounded, and never looks cancelled", async () => {
  const { fetcher, calls } = fakeGithub({
    runs: [{ id: 31, status: "in_progress", display_title: UBUNTU }],
    pollsBeforeDone: null,
  });
  const { waits, sleep } = fakeSleep();

  const result = await cancelBrowserCheckRuns("ubuntu", {
    fetcher,
    sleep,
    readSecret: async () => TOKEN,
    waitTimeoutMs: 3_000,
    pollIntervalMs: 1_000,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.step, "cancel");
  assert.match(result.error, /did not stop within 3 seconds/);
  assert.match(result.error, /no replacement was dispatched/i);
  assert.deepEqual(result.stillRunning, [31]);
  assert.equal(waits.length, 2, "three observations, two sleeps, then the bound");
  assert.equal(
    calls.filter((call) => call.method === "POST").length,
    1,
    "one cancel request, not a retry loop",
  );
});

test("a missing token refuses before any request, and never echoes itself", async () => {
  const { fetcher, calls } = fakeGithub({ runs: [] });

  const result = await cancelBrowserCheckRuns("ubuntu", {
    fetcher,
    sleep: async () => {},
    readSecret: async () => undefined,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.step, "cancel");
  assert.match(result.error, /GITHUB_BURST_TOKEN/);
  assert.match(result.error, /cannot be cancelled/i);
  assert.equal(calls.length, 0, "no token means no request");
});

for (const status of [401, 403]) {
  test(`a ${status} from the list names the cancel step and the token variable`, async () => {
    const { fetcher, calls } = fakeGithub({ listStatus: status });

    const result = await cancelBrowserCheckRuns("ubuntu", {
      fetcher,
      sleep: async () => {},
      readSecret: async () => TOKEN,
    });

    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.step, "cancel");
    assert.match(result.error, new RegExp(String(status)));
    assert.match(result.error, /GITHUB_BURST_TOKEN/);
    assert.equal(result.error.includes(TOKEN), false);
    assert.equal(
      calls.filter((call) => call.method === "POST").length,
      0,
      "a run that was never found is never cancelled blindly",
    );
  });
}

test("a 429 from the list is its own failure, not a bad credential", async () => {
  const { fetcher, calls } = fakeGithub({ listStatus: 429 });

  const result = await cancelBrowserCheckRuns("ubuntu", {
    fetcher,
    sleep: async () => {},
    readSecret: async () => TOKEN,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.step, "cancel");
  assert.match(result.error, /rate-limited/);
  assert.match(result.error, /429/);
  assert.equal(result.error.includes(TOKEN), false);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("a refused cancel is a failure, not an assumption of success", async () => {
  const { fetcher, calls } = fakeGithub({
    runs: [{ id: 41, status: "in_progress", display_title: UBUNTU }],
    cancelStatus: 403,
  });

  const result = await cancelBrowserCheckRuns("ubuntu", {
    fetcher,
    sleep: async () => {},
    readSecret: async () => TOKEN,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.step, "cancel");
  assert.match(result.error, /403/);
  assert.match(result.error, /GITHUB_BURST_TOKEN/);
  assert.equal(result.error.includes(TOKEN), false);
  assert.deepEqual(result.stillRunning, [41]);
  assert.equal(
    calls.filter((call) => call.method === "GET" && /\/runs\/41$/.test(call.path))
      .length,
    0,
    "a refused cancel is not polled as if it might have worked",
  );
});

test("a 404 or 409 on cancel is not a failure, but the stop must still be observed", async () => {
  for (const cancelStatus of [404, 409]) {
    const { fetcher } = fakeGithub({
      runs: [{ id: 51, status: "in_progress", display_title: UBUNTU }],
      cancelStatus,
    });

    const result = await cancelBrowserCheckRuns("ubuntu", {
      fetcher,
      sleep: async () => {},
      readSecret: async () => TOKEN,
      waitTimeoutMs: 1_000,
      pollIntervalMs: 1_000,
    });

    // The fake keeps the id and reports it running. A run GitHub says it
    // cannot cancel is still treated as possibly clicking: the read never
    // saw it stop, so this is not a cancellation.
    assert.equal(result.ok, false, `cancel ${cancelStatus}`);
    if (result.ok) throw new Error("unreachable");
    assert.deepEqual(result.stillRunning, [51]);
  }
});

test("the cancel request carries the exact headers, timeout and no cache", async () => {
  const { fetcher, calls } = fakeGithub({
    runs: [{ id: 61, status: "in_progress", display_title: UBUNTU }],
    pollsBeforeDone: 1,
  });

  await cancelBrowserCheckRuns("ubuntu", {
    fetcher,
    sleep: async () => {},
    readSecret: async () => TOKEN,
  });

  const cancel = calls.find((call) => call.method === "POST");
  assert.ok(cancel);
  assert.equal(
    cancel.path,
    `/repos/${REPO}/actions/runs/61/cancel`,
  );
  assert.deepEqual(cancel.init?.headers, {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${TOKEN}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "voni-restart",
  });
  assert.equal(cancel.init?.cache, "no-store");
  assert.ok(cancel.init?.signal, "a cancel must be bounded by a timeout too");

  const list = calls.find(
    (call) => call.method === "GET" && call.path.includes("/runs?"),
  );
  assert.ok(list);
  assert.equal(
    list.path,
    `/repos/${REPO}/actions/workflows/${BROWSER_CHECK_WORKFLOW_FILE}/runs?per_page=100`,
  );
});

test("no returned string contains the token, whatever GitHub answers", async () => {
  const runs = [{ id: 71, status: "in_progress", display_title: UBUNTU }];
  const outcomes = await Promise.all([
    cancelBrowserCheckRuns("ubuntu", {
      fetcher: fakeGithub({ runs, listStatus: 403 }).fetcher,
      sleep: async () => {},
      readSecret: async () => TOKEN,
    }),
    cancelBrowserCheckRuns("ubuntu", {
      fetcher: fakeGithub({ runs, cancelStatus: 403 }).fetcher,
      sleep: async () => {},
      readSecret: async () => TOKEN,
    }),
    cancelBrowserCheckRuns("ubuntu", {
      fetcher: fakeGithub({ runs, pollsBeforeDone: null }).fetcher,
      sleep: async () => {},
      readSecret: async () => TOKEN,
      waitTimeoutMs: 1_000,
      pollIntervalMs: 1_000,
    }),
    cancelBrowserCheckRuns("ubuntu", {
      fetcher: (async () => {
        throw new Error(`connect failed while sending ${TOKEN}`);
      }) as unknown as typeof fetch,
      sleep: async () => {},
      readSecret: async () => TOKEN,
    }),
  ]);

  for (const result of outcomes) {
    assert.equal(JSON.stringify(result).includes(TOKEN), false, JSON.stringify(result));
  }
});
