import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Shared delete-rail job helpers used by deleteAgentAction and
// deleteCampaignAction. Cancel semantics (guarded queued update, claim-race
// fallback, terminal-only hard delete) are asserted here on the real module
// source — the action tests only assert wiring and ordering.
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "cancel-linked.ts"),
  "utf8",
);

test("helper exports the full delete rail", () => {
  assert.ok(source.includes("cancelOneLinkedJob"));
  assert.ok(source.includes("cancelLinkedJobs"));
  assert.ok(source.includes("cancelFreshLinkedJobs"));
  assert.ok(source.includes("deleteTerminalLinkedJobs"));
});

test("job status is a domain union, never a bare string", () => {
  assert.ok(source.includes("LinkedJobStatus"));
  assert.ok(source.includes('"queued"'));
  assert.ok(source.includes('"running"'));
  assert.ok(!source.includes("status: string"), "status deserves the union");
});

test("queued-cancel is guarded and detects claim races", () => {
  const fn = source.slice(source.indexOf("cancelOneLinkedJob"));
  // Guarded on status='queued' with affected-row readback so a claimJob that
  // flipped the row to running is detected instead of silently escaping.
  assert.ok(fn.includes(".returning("), "must check affected rows");
  assert.ok(
    fn.includes('"running"') && fn.includes("cancelRequested"),
    "zero affected rows must fall back to flagging the now-running row",
  );
});

test("running jobs are flagged, never force-cancelled", () => {
  const fn = source.slice(source.indexOf("cancelOneLinkedJob"));
  assert.ok(fn.includes('status === "running"'));
  assert.ok(fn.includes("cancelRequested: true"));
});

test("hard delete is terminal-only, by id, never by title", () => {
  const fn = source.slice(source.indexOf("deleteTerminalLinkedJobs"));
  assert.ok(fn.includes("delete(backgroundJobs)"));
  assert.ok(fn.includes("eq(backgroundJobs.id, jobId)"));
  assert.ok(fn.includes('"succeeded"'), "succeeded rows are deletable");
  assert.ok(fn.includes('"failed"'), "failed rows are deletable");
  assert.ok(fn.includes('"cancelled"'), "cancelled tombstones are deletable");
  assert.ok(
    !fn.includes('"running"') && !fn.includes('"queued"'),
    "running/queued rows must not be hard-deleted",
  );
  assert.ok(!fn.includes("ilike"), "title-ILIKE would erase other rows' jobs");
});

test("fresh sweep re-cancels queued and flags unflagged running", () => {
  const fn = source.slice(source.indexOf("cancelFreshLinkedJobs"));
  assert.ok(fn.includes('"queued"'), "sweep must re-cancel still-queued jobs");
  assert.ok(
    fn.includes("cancelRequested"),
    "sweep must flag unflagged running jobs",
  );
  assert.ok(
    fn.includes("cancelOneLinkedJob"),
    "sweep reuses the guarded single cancel",
  );
});
