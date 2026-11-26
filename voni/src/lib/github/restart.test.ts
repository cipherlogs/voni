/**
 * Restart as one sequence: cancel the OS's running Segment, prove it stopped,
 * then dispatch exactly one replacement.
 *
 * The orchestrator is driven with injected dependencies, so the first half of
 * this file needs no GitHub at all — it pins the order and, more importantly,
 * every path where a restart must *not* dispatch. The last tests wire the real
 * cancel client and the real dispatcher to one in-memory GitHub and assert the
 * ticket's invariant directly: after one Restart, an OS has one run, not two.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_CHECK_WORKFLOW_FILE,
  browserCheckRunName,
  cancelBrowserCheckRuns,
  dispatchBrowserCheck,
  type BrowserCheckInput,
  type CancelOutcome,
  type DispatchOutcome,
} from "./dispatch";
import { restartSegment } from "./restart";

const TOKEN = "ghp_restartsecretvalue123";

const REQUEST: BrowserCheckInput = {
  os: "ubuntu",
  targets: ["https://example.com/a"],
  intervalSeconds: 60,
  windowSeconds: 600,
  selection: "random",
};

function cancelled(runIds: number[] = [7]): CancelOutcome {
  return runIds.length === 0
    ? { ok: true, cancelled: false, runIds: [] }
    : { ok: true, cancelled: true, runIds };
}

function dispatched(runUrl = "https://github.com/cipherlogs/voni/actions"): DispatchOutcome {
  return { ok: true, mode: "dispatched", runUrl };
}

/** The order of the two external calls, which is the whole point. */
function recorded() {
  const calls: string[] = [];
  return {
    calls,
    cancel: async (os: string) => {
      calls.push(`cancel:${os}`);
      return cancelled();
    },
    dispatch: async (input: BrowserCheckInput) => {
      calls.push(`dispatch:${input.os}`);
      return dispatched();
    },
  };
}

test("cancel is observed before exactly one dispatch runs", async () => {
  const { calls, cancel, dispatch } = recorded();

  const result = await restartSegment(REQUEST, { cancel, dispatch });

  assert.deepEqual(calls, ["cancel:ubuntu", "dispatch:ubuntu"]);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "replaced");
  assert.deepEqual(result.cancelledRunIds, [7]);
});

test("nothing was running: a restart is one plain start", async () => {
  const calls: string[] = [];
  const result = await restartSegment(REQUEST, {
    cancel: async () => {
      calls.push("cancel");
      return cancelled([]);
    },
    dispatch: async () => {
      calls.push("dispatch");
      return dispatched();
    },
  });

  assert.deepEqual(calls, ["cancel", "dispatch"]);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "started");
  assert.deepEqual(result.cancelledRunIds, []);
});

test("a cancel failure stops the restart: no replacement is dispatched", async () => {
  let dispatches = 0;
  const result = await restartSegment(REQUEST, {
    cancel: async () => ({
      ok: false,
      step: "cancel",
      error: "GitHub refused the cancel (403).",
      stillRunning: [7],
    }),
    dispatch: async () => {
      dispatches += 1;
      return dispatched();
    },
  });

  assert.equal(dispatches, 0, "the old Segment may still be clicking");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.step, "cancel");
  assert.match(result.error, /403/);
});

test("an unobserved cancellation is reported and never replaced", async () => {
  let dispatches = 0;
  const timeout: CancelOutcome = {
    ok: false,
    step: "cancel",
    error:
      "The ubuntu run did not stop within 60 seconds of the cancel request, so no replacement was dispatched.",
    stillRunning: [7],
  };

  const result = await restartSegment(REQUEST, {
    cancel: async () => timeout,
    dispatch: async () => {
      dispatches += 1;
      return dispatched();
    },
  });

  assert.equal(dispatches, 0);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.step, "cancel");
  assert.match(result.error, /did not stop/);
  assert.match(result.error, /no replacement was dispatched/i);
});

test("a dispatch failure names the dispatch step, after one attempt", async () => {
  let dispatches = 0;
  const result = await restartSegment(REQUEST, {
    cancel: async () => cancelled(),
    dispatch: async () => {
      dispatches += 1;
      return { ok: false, error: "GitHub rate-limited the browser check dispatch (429)." };
    },
  });

  assert.equal(dispatches, 1, "one replacement, never a retry storm");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.step, "dispatch");
  assert.match(result.error, /429/);
});

test("a manual result is a success that carries the command, not a dispatch", async () => {
  const result = await restartSegment(REQUEST, {
    cancel: async () => cancelled([]),
    dispatch: async () => ({
      ok: true,
      mode: "manual",
      fallback: { command: "gh workflow run browser-check.yml" },
    }),
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "manual");
  assert.equal(result.fallback?.command, "gh workflow run browser-check.yml");
  assert.equal(result.runUrl, undefined);
});

test("the success message says the throttle was bypassed on purpose", async () => {
  for (const cancel of [async () => cancelled(), async () => cancelled([])]) {
    const result = await restartSegment(REQUEST, {
      cancel,
      dispatch: async () => dispatched(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.match(result.message, /restart/i);
    assert.match(result.message, /bypass/i, "a restart is deliberately not throttled");
    assert.match(result.message, /throttle/i, "and it says what was bypassed");
    assert.match(result.message, /recorded/i, "the ticker will not immediately re-dispatch");
  }
});

/**
 * One GitHub, two functions: the real client and the real dispatcher. Runs are
 * versioned in memory, and a cancel only stops a run when `honourCancel` is
 * true, so the "a runner ignores the cancel" failure is exercised end to end.
 */
function fakeGithub(options: { pollsBeforeDone?: number; honourCancel?: boolean } = {}) {
  const honourCancel = options.honourCancel ?? true;
  const pollsBeforeDone = options.pollsBeforeDone ?? 1;
  const runs = [
    { id: 100, status: "in_progress", display_title: browserCheckRunName("ubuntu") },
  ];
  let nextId = 101;
  const calls: string[] = [];
  const polls = new Map<number, number>();

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    if (method === "GET" && url.pathname.endsWith("/runs")) {
      calls.push("list");
      return Response.json({ total_count: runs.length, workflow_runs: runs });
    }

    const cancel = /\/actions\/runs\/(\d+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && cancel) {
      calls.push(`cancel:${cancel[1]}`);
      const run = runs.find((entry) => entry.id === Number(cancel[1]));
      if (run && honourCancel) run.status = "cancelling";
      return new Response(null, { status: 202 });
    }

    const poll = /\/actions\/runs\/(\d+)$/.exec(url.pathname);
    if (method === "GET" && poll) {
      calls.push(`poll:${poll[1]}`);
      const run = runs.find((entry) => entry.id === Number(poll[1]));
      if (!run) return new Response(null, { status: 404 });
      const seen = (polls.get(run.id) ?? 0) + 1;
      polls.set(run.id, seen);
      const status =
        honourCancel && seen >= pollsBeforeDone ? "completed" : run.status;
      run.status = status;
      return Response.json({ id: run.id, status });
    }

    if (method === "POST" && url.pathname.endsWith("/dispatches")) {
      const body = JSON.parse(String(init?.body)) as { inputs: Record<string, string> };
      calls.push(`dispatch:${body.inputs.os}`);
      runs.push({
        id: nextId++,
        status: "in_progress",
        display_title: browserCheckRunName(body.inputs.os as BrowserCheckInput["os"]),
      });
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 500 });
  }) as unknown as typeof fetch;

  const activeFor = (os: BrowserCheckInput["os"]) =>
    runs.filter(
      (run) => run.status !== "completed" && run.display_title === browserCheckRunName(os),
    );

  return { fetcher, runs, calls, activeFor };
}

test("end to end: one Restart leaves the OS with one run, the replacement", async () => {
  const github = fakeGithub({ pollsBeforeDone: 2 });
  const readSecret = async () => TOKEN;

  const result = await restartSegment(REQUEST, {
    cancel: (os) =>
      cancelBrowserCheckRuns(os, {
        fetcher: github.fetcher,
        readSecret,
        sleep: async () => {},
        waitTimeoutMs: 5_000,
        pollIntervalMs: 1_000,
      }),
    dispatch: (input) =>
      dispatchBrowserCheck(input, {
        fetcher: github.fetcher,
        readSecret,
        readPoolTarget: async () => 5,
      }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const active = github.activeFor("ubuntu");
  assert.equal(active.length, 1, "two Segments would click the same target twice");
  assert.equal(active[0]?.id, 101, "the one running is the replacement");
  assert.equal(
    github.runs.find((run) => run.id === 100)?.status,
    "completed",
    "the old Segment stopped before the new one started",
  );

  const cancelAt = github.calls.indexOf("cancel:100");
  const dispatchAt = github.calls.indexOf("dispatch:ubuntu");
  assert.ok(cancelAt >= 0 && dispatchAt > cancelAt, "dispatch follows the cancel");
  assert.ok(
    github.calls.indexOf("poll:100") < dispatchAt,
    "the replacement waits for an observed stop, not just a cancel request",
  );
});

test("end to end: a runner that ignores the cancel never gets company", async () => {
  const github = fakeGithub({ honourCancel: false });
  const readSecret = async () => TOKEN;

  const result = await restartSegment(REQUEST, {
    cancel: (os) =>
      cancelBrowserCheckRuns(os, {
        fetcher: github.fetcher,
        readSecret,
        sleep: async () => {},
        waitTimeoutMs: 2_000,
        pollIntervalMs: 1_000,
      }),
    dispatch: (input) =>
      dispatchBrowserCheck(input, {
        fetcher: github.fetcher,
        readSecret,
        readPoolTarget: async () => 5,
      }),
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.step, "cancel");
  assert.match(result.error, /no replacement was dispatched/i);

  const active = github.activeFor("ubuntu");
  assert.equal(active.length, 1, "the old Segment is still the only one running");
  assert.equal(
    github.calls.some((call) => call.startsWith("dispatch:")),
    false,
    "nothing was dispatched while the old one was still clicking",
  );
  assert.equal(
    github.calls.some((call) => call.startsWith(`cancel:`) && call !== "cancel:100"),
    false,
    "no second cancel loop",
  );
});

test("the token never reaches the operator's sentence", async () => {
  const github = fakeGithub({ honourCancel: false });
  const readSecret = async () => TOKEN;

  const outcome = await restartSegment(REQUEST, {
    cancel: (os) =>
      cancelBrowserCheckRuns(os, {
        fetcher: github.fetcher,
        readSecret,
        sleep: async () => {},
        waitTimeoutMs: 1_000,
        pollIntervalMs: 1_000,
      }),
    dispatch: (input) =>
      dispatchBrowserCheck(input, {
        fetcher: github.fetcher,
        readSecret,
        readPoolTarget: async () => 5,
      }),
  });

  assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
});

test("the workflow file the client reads is the browser check's", () => {
  assert.equal(BROWSER_CHECK_WORKFLOW_FILE, "browser-check.yml");
});
