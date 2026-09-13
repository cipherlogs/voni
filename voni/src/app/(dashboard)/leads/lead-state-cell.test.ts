import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as calls-index.test.ts): the repo
// has no jsdom/component-render setup, so the cell shape, empty state, and
// import hint are checked on the real source.
const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "page.tsx"), "utf8");

const cellSource = pageSource.slice(
  pageSource.indexOf("export function LeadStateCell"),
);

test("lead State cell reads without hover: two lines, no truncation tooltip", () => {
  assert.ok(cellSource.includes("line-clamp-2"), "context line clamps, not truncates");
  assert.ok(!cellSource.includes("truncate "), "no single-line truncate class in the cell");
  assert.ok(!cellSource.includes("Tooltip"), "no hover-only Tooltip wrapper");
  assert.ok(cellSource.includes("text-foreground"), "next action stays foreground");
});

test("lead State cell is not an extra tab stop: no tabIndex on static text", () => {
  assert.ok(!cellSource.includes("tabIndex"), "static cell text is not focusable");
  assert.ok(cellSource.includes("aria-label"), "full text still exposed to assistive tech");
});

test("overlong blockers get a real expander, not a silent clip", () => {
  assert.ok(cellSource.includes("<details"), "long context collapses behind a disclosure");
  assert.ok(cellSource.includes("<summary"), "disclosure has a real summary affordance");
  assert.ok(cellSource.includes("Show full context"), "expander names the action");
  assert.ok(cellSource.includes("Show less"), "open state offers collapse");
  assert.ok(!cellSource.includes("title="), "no title-tooltip-only text");
});

test("lead State cell is a div, not a details-in-span violation", () => {
  assert.ok(
    cellSource.includes("<div") && cellSource.includes('aria-label={accessibleName}'),
    "cell root is a flow-content div carrying the accessible name",
  );
  const openTag = cellSource.slice(cellSource.indexOf("return ("));
  assert.ok(!openTag.startsWith("return (\n    <span"), "root is not a span");
});

test("leads empty state uses the padded Empty composition", () => {
  assert.ok(pageSource.includes("EmptyTitle"), "empty state uses the Empty pattern");
  assert.ok(pageSource.includes("No leads yet"), "empty title names the state");
  assert.ok(
    pageSource.includes("campaign runs an import"),
    "empty state names the next action",
  );
  const emptyBlock = pageSource.slice(
    pageSource.indexOf("rows.length === 0"),
    pageSource.indexOf("rows.map"),
  );
  assert.ok(
    !emptyBlock.includes("h-40"),
    "no cramped fixed-height empty cell (suspense fallback keeps its own)",
  );
});

test("import button names where the import happens", () => {
  assert.ok(pageSource.includes("Import via a campaign"));
  assert.ok(
    pageSource.includes("each campaign imports its own CSV"),
    "one clause of hint text beside the button",
  );
});
