import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_AFTER_MS,
  getJobProgressPercent,
  jobErrorCopy,
  partitionJobs,
  shouldSuppressJobToast,
  type MinimalJob,
} from "./ui-helpers";

function job(overrides: Partial<MinimalJob> = {}): MinimalJob {
  return {
    id: "job-1",
    kind: "lead_csv_import",
    status: "running",
    title: "Import leads.csv",
    progressTotal: null,
    progressDone: null,
    stage: null,
    errorCode: null,
    seenAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

test("background threshold matches the 3s async protocol", () => {
  assert.equal(BACKGROUND_AFTER_MS, 3000);
});

test("progress percent is null without a total", () => {
  assert.equal(getJobProgressPercent(job()), null);
  assert.equal(
    getJobProgressPercent(job({ progressTotal: 200, progressDone: 50 })),
    25,
  );
});

test("progress percent clamps to 0..100", () => {
  assert.equal(
    getJobProgressPercent(job({ progressTotal: 0, progressDone: 5 })),
    null,
  );
  assert.equal(
    getJobProgressPercent(job({ progressTotal: 100, progressDone: 150 })),
    100,
  );
  assert.equal(
    getJobProgressPercent(job({ progressTotal: 100, progressDone: -5 })),
    0,
  );
});

test("partitionJobs splits active, unread, and history", () => {
  const active = job({ id: "a", status: "running" });
  const unread = job({ id: "u", status: "succeeded" });
  const seen = job({ id: "s", status: "succeeded", seenAt: "2026-09-07T00:00:00Z" });
  const dismissed = job({
    id: "d",
    status: "failed",
    dismissedAt: "2026-09-07T00:00:00Z",
  });
  const { activeJobs, unreadJobs, history } = partitionJobs([
    active,
    unread,
    seen,
    dismissed,
  ]);
  assert.deepEqual(
    activeJobs.map((j) => j.id),
    ["a"],
  );
  assert.deepEqual(
    unreadJobs.map((j) => j.id),
    ["u"],
  );
  assert.deepEqual(
    history.map((j) => j.id),
    ["s", "d"],
  );
});

test("queued counts as active, fresh cancelled counts as unread", () => {
  const { activeJobs, unreadJobs, history } = partitionJobs([
    job({ id: "q", status: "queued" }),
    job({ id: "c", status: "cancelled" }),
  ]);
  assert.deepEqual(
    activeJobs.map((j) => j.id),
    ["q"],
  );
  assert.deepEqual(
    unreadJobs.map((j) => j.id),
    ["c"],
  );
  assert.deepEqual(
    history.map((j) => j.id),
    [],
  );
});

test("shouldSuppressJobToast suppresses inline-consumed results", () => {
  const cases: Array<{
    kind: string;
    status: string;
    pathname: string;
    expected: boolean;
  }> = [
    // Suppressed.
    { kind: "agent_generation", status: "succeeded", pathname: "/agents/new", expected: true },
    { kind: "agent_generation", status: "failed", pathname: "/agents/new", expected: true },
    { kind: "agent_deployment", status: "succeeded", pathname: "/agents/abc-123", expected: true },
    { kind: "agent_deployment", status: "failed", pathname: "/agents/abc-123", expected: true },
    // Not suppressed: generation consumed only on the wizard page.
    { kind: "agent_generation", status: "succeeded", pathname: "/agents/abc", expected: false },
    { kind: "agent_generation", status: "succeeded", pathname: "/jobs", expected: false },
    // Not suppressed: cancelled deployments stay global (the detail watcher
    // banners them but never toasts, so the global toast is the only ping).
    { kind: "agent_deployment", status: "cancelled", pathname: "/agents/abc-123", expected: false },
    { kind: "agent_deployment", status: "succeeded", pathname: "/agents", expected: false },
    { kind: "agent_deployment", status: "succeeded", pathname: "/agents/", expected: false },
    { kind: "agent_deployment", status: "succeeded", pathname: "/agents/new", expected: false },
    { kind: "agent_deployment", status: "succeeded", pathname: "/agents/abc/calls", expected: false },
    { kind: "agent_deployment", status: "succeeded", pathname: "/jobs", expected: false },
    // Not suppressed: other kinds always toast globally.
    { kind: "lead_csv_import", status: "succeeded", pathname: "/jobs", expected: false },
    { kind: "lead_csv_import", status: "succeeded", pathname: "/agents/new", expected: false },
    // Empty pathname never suppresses.
    { kind: "agent_generation", status: "succeeded", pathname: "", expected: false },
    { kind: "agent_deployment", status: "succeeded", pathname: "", expected: false },
  ];
  for (const { kind, status, pathname, expected } of cases) {
    assert.equal(
      shouldSuppressJobToast(kind, status, pathname),
      expected,
      `${kind}/${status} on ${pathname || "(empty)"}`,
    );
  }
});

test("jobErrorCopy gives distinct copy per failure mode", () => {
  assert.match(jobErrorCopy("rate-limited"), /busy|later|limit/i);
  assert.match(jobErrorCopy("auth"), /permission|sign|access/i);
  assert.match(jobErrorCopy("timeout"), /long|timed out/i);
  assert.ok(jobErrorCopy("unknown").length > 0);
  assert.ok(jobErrorCopy(null).length > 0);
});
