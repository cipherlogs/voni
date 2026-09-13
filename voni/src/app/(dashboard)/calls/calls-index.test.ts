import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as actions.delete.test.ts and
// delete-agent-button.test.tsx): the repo has no jsdom/component-render
// setup, so list shape, empty states, and data-layer guard rails are checked
// on the real sources.
const dir = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(dir, "page.tsx"), "utf8");
const agentsSource = readFileSync(join(dir, "..", "agents", "page.tsx"), "utf8");
const sectionSource = readFileSync(
  join(dir, "..", "..", "..", "components", "calls", "recent-calls.tsx"),
  "utf8",
);
const dataSource = readFileSync(
  join(dir, "..", "..", "..", "lib", "copilot", "detail-data.ts"),
  "utf8",
);
const formatSource = readFileSync(
  join(dir, "..", "..", "..", "lib", "calls", "format.ts"),
  "utf8",
);

test("calls index mirrors the leads table shape", () => {
  assert.ok(indexSource.includes("TableHeader"));
  assert.ok(indexSource.includes("TableBody"));
  assert.ok(indexSource.includes("TableRow"));
  assert.ok(indexSource.includes("TableCell"));
  // Pagination footer uses the shadcn composition, not a raw tfoot.
  assert.ok(indexSource.includes("TableFooter"));
  assert.ok(!indexSource.includes("<tfoot>"));
  assert.ok(!indexSource.includes("<td"));
});

test("calls index rows link to detail with direction badges and durations", () => {
  assert.ok(indexSource.includes("/calls/${call.id}"));
  assert.ok(indexSource.includes("Inbound"));
  assert.ok(indexSource.includes("Outbound"));
  assert.ok(indexSource.includes("relativeCallTime"));
  assert.ok(indexSource.includes("callDuration"));
  assert.ok(indexSource.includes("RouteBrief"));
});

test("calls index paginates 20 per page with clamped, reversible navigation", () => {
  assert.ok(indexSource.includes("CALLS_PAGE_SIZE = 20"));
  assert.ok(indexSource.includes("Math.max(1"));
  assert.ok(indexSource.includes("Previous"));
  assert.ok(indexSource.includes("Next"));
  assert.ok(indexSource.includes("aria-disabled"));
  assert.ok(indexSource.includes("Page {safePage}"));
});

test("calls index empty states distinguish no-calls from overshot pages", () => {
  assert.ok(indexSource.includes("Empty"));
  assert.ok(indexSource.includes("EmptyTitle"));
  assert.ok(indexSource.includes("No calls yet"));
  assert.ok(indexSource.includes("No calls on this page"));
});

test("recent-calls section lives outside the agents list, with its own empty state", () => {
  // Recent calls was removed from /agents (not useful there) — calls live
  // under /calls. The section component contract itself is unchanged.
  assert.ok(!agentsSource.includes("RecentCalls"));
  assert.ok(sectionSource.includes("Recent calls"));
  assert.ok(sectionSource.includes('href="/calls"'));
  assert.ok(sectionSource.includes("View all"));
  assert.ok(sectionSource.includes("Empty"));
  assert.ok(sectionSource.includes("No calls yet"));
  // Section cap: 5 rows, lead + relative time + direction badge each.
  assert.ok(dataSource.includes("limit(5)") || dataSource.includes(", 5)"));
  assert.ok(sectionSource.includes("/calls/${call.id}"));
  assert.ok(sectionSource.includes("relativeCallTime"));
  // Composes via render= (Base UI), never asChild.
  assert.ok(sectionSource.includes("render="));
  assert.ok(!sectionSource.includes("asChild"));
});

test("call list data stays org-scoped on the proven join", () => {
  const fn = dataSource.slice(dataSource.indexOf("export async function listCalls"));
  assert.ok(fn.includes("innerJoin(leads"));
  assert.ok(fn.includes("eq(leads.organizationId, ctx.organizationId)"));
  assert.ok(fn.includes("desc(calls.startedAt)"));
  assert.ok(fn.includes("offset("));
  assert.ok(!fn.includes("ilike"), "no title search — pagination only");
});

test("call time formatting is arithmetic-only (hydration-safe)", () => {
  assert.ok(formatSource.includes("relativeCallTime"));
  assert.ok(formatSource.includes("callDuration"));
  assert.ok(!formatSource.includes("toLocale"), "locale formatting would hydrate-mismatch");
});
