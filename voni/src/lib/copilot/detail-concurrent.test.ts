import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Ticket 03: Call trace detail loads concurrently once context resolves.
// Seam: server data boundary (detail-data + calls/[id] + leads/[id] pages).
// No jsdom/component-render setup in this repo, so concurrency structure
// and data-shape preservation are checked on the real sources — the same
// approach as calls-index.test.ts / calls-pagination.test.ts.
const dir = dirname(fileURLToPath(import.meta.url));
const callsPage = readFileSync(
  join(dir, "..", "..", "app", "(dashboard)", "calls", "[id]", "page.tsx"),
  "utf8",
);
const leadsPage = readFileSync(
  join(dir, "..", "..", "app", "(dashboard)", "leads", "[id]", "page.tsx"),
  "utf8",
);
const dataSource = readFileSync(join(dir, "detail-data.ts"), "utf8");

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

test("call detail resolves session context exactly once per page", () => {
  // callDetail() already resolves ctx internally; the page must reuse it
  // instead of a second requireCtxOrRedirect (duplicate session+member
  // resolution). Total across the page + callDetail must be one.
  const fn = dataSource.slice(
    dataSource.indexOf("export async function callDetail"),
    dataSource.indexOf("export async function listCalls"),
  );
  const total =
    countOccurrences(callsPage, "requireCtxOrRedirect") +
    countOccurrences(fn, "requireCtxOrRedirect");
  assert.equal(total, 1, `expected 1 ctx resolution, found ${total}`);
});

test("call detail reads link/turns/tools/outcome together", () => {
  assert.ok(
    callsPage.includes("Promise.all"),
    "calls detail page fans reads out with Promise.all",
  );
});

test("call detail keeps the same data: limits, ordering, and composition", () => {
  for (const needle of [
    ".limit(100)",
    ".limit(50)",
    ".limit(1)",
    "asc(messages.createdAt)",
    "asc(toolCallLogs.createdAt)",
    "desc(conversationStates.createdAt)",
    "CallDetailSkeleton",
    "Suspense",
    "No turns recorded",
    "No actions recorded",
  ]) {
    assert.ok(callsPage.includes(needle), `calls detail keeps ${needle}`);
  }
  assert.ok(
    !callsPage.includes("requireCtxOrRedirect"),
    "calls page reuses the ctx from callDetail instead of re-resolving",
  );
});

test("lead detail reads calls/memberships/activity together", () => {
  assert.ok(
    leadsPage.includes("Promise.all"),
    "leads detail page fans reads out with Promise.all",
  );
});

test("lead detail keeps the same data: limits, ordering, and composition", () => {
  for (const needle of [
    ".limit(20)",
    ".limit(50)",
    "desc(calls.startedAt)",
    "desc(campaignLeads.createdAt)",
    "desc(messages.createdAt)",
    "LeadDetailSkeleton",
    "Suspense",
    "No calls yet",
    "Not in any campaign",
    "No messages yet",
  ]) {
    assert.ok(leadsPage.includes(needle), `leads detail keeps ${needle}`);
  }
});

test("leadDetail resolves ctx once and reads lead/state together", () => {
  const fn = dataSource.slice(dataSource.indexOf("export async function leadDetail"));
  const body = fn.slice(0, fn.indexOf("export async function callDetail"));
  assert.equal(
    countOccurrences(body, "requireCtxOrRedirect"),
    1,
    "leadDetail resolves ctx exactly once",
  );
  assert.ok(body.includes("Promise.all"), "lead + state resolve together");
});
