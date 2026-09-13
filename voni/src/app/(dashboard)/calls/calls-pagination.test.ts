import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as calls-index.test.ts): the repo
// has no jsdom/component-render setup, so totals, timestamp treatment, and
// per-row affordance are checked on the real sources.
const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "page.tsx"), "utf8");
const dataSource = readFileSync(
  join(dir, "..", "..", "..", "lib", "copilot", "detail-data.ts"),
  "utf8",
);

test("calls list query exposes an exact total on the same org-scoped join", () => {
  const fn = dataSource.slice(dataSource.indexOf("export async function listCalls"));
  assert.ok(fn.includes("count()"), "exact total via count()");
  assert.ok(fn.includes("eq(leads.organizationId"), "total keeps the org scope");
  assert.ok(fn.includes("total"), "total is returned to the page");
});

test("calls footer reports totals, not a bare page number", () => {
  assert.ok(pageSource.includes("totalPages"), "page count derived from the total");
  assert.ok(pageSource.includes("of {totalPages}"), "footer renders page-of-N");
  assert.ok(!pageSource.includes("Page {safePage}\n"), "no bare Page N label");
});

test("calls result count renders on every page, filtered or not", () => {
  assert.ok(pageSource.includes("countLabel"), "count label computed from the total");
  assert.ok(pageSource.includes('role="status"'), "count is a live status region");
  assert.ok(
    pageSource.includes("Filtered results:"),
    "filtered count names the outcome",
  );
  const footerBlock = pageSource.slice(pageSource.indexOf("<TableFooter>"));
  assert.ok(
    !footerBlock.includes("countLabel"),
    "count lives outside the paged footer",
  );
});

test("absolute start time reads without hover and joins link text", () => {
  assert.ok(pageSource.includes("Started"), "Started column header stays");
  assert.ok(pageSource.includes("absoluteCallTime"), "absolute time rendered as text");
  assert.ok(pageSource.includes("started ${absolute}"), "absolute time folded into link text");
  assert.ok(
    !pageSource.includes("toISOString()"),
    "no tooltip-only ISO time",
  );
});

test("pagination buttons meet the touch-target floor", () => {
  assert.ok(
    pageSource.includes("min-h-11 min-w-11"),
    "prev/next lift size=sm toward the 44px floor",
  );
});

test("each calls row has an explicit Open call affordance", () => {
  const matches = pageSource.match(/Open call/g) ?? [];
  assert.ok(matches.length >= 2, "visible Open call link plus sr-only header");
  assert.ok(pageSource.includes("sr-only"), "action column header stays screen-reader-only");
});
