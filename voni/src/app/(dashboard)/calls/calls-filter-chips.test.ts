import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as calls-pagination.test.ts): the repo
// has no jsdom/component-render setup, so the chips row is checked on the
// real source.
const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "page.tsx"), "utf8");

test("calls chips reuse the existing ?outcome= params", () => {
  assert.ok(pageSource.includes("callsChips"), "calls chips helper exists");
  assert.ok(pageSource.includes("/calls?outcome=connected"), "Connected chip reuses ?outcome=");
  assert.ok(pageSource.includes("/calls?outcome=booked"), "Booked chip reuses ?outcome=");
  assert.ok(pageSource.includes("/calls?outcome=handoff"), "Handoff chip reuses ?outcome=");
});

test("calls chips resolve inside a Suspense leaf above the Card, never the shell or the table", () => {
  const shell = pageSource.slice(
    pageSource.indexOf("export default function CallsPage"),
  );
  assert.ok(!shell.includes("await searchParams"), "shell never awaits searchParams");
  // A <nav> child of <table> is invalid HTML (hydration error) — the chips
  // leaf renders above the Card, and the rows leaf carries only TableBody
  // rows.
  assert.ok(shell.includes("<CallsChips"), "chips render in a shell Suspense leaf");
  const leaf = pageSource.slice(
    pageSource.indexOf("async function CallsChips"),
    pageSource.indexOf("export default function CallsPage"),
  );
  assert.ok(leaf.includes("<FilterChips"), "chips mount inside the chips leaf");
  const rowsLeaf = pageSource.slice(
    pageSource.indexOf("async function CallsRows"),
    pageSource.indexOf("async function CallsChips"),
  );
  assert.ok(!rowsLeaf.includes("<FilterChips"), "rows leaf carries no nav");
});

test("Connected filter names its grain (calls, not leads)", () => {
  assert.ok(
    pageSource.includes("Connected counts calls, not leads"),
    "chip row carries the one-line grain hint",
  );
});

test("existing Badge+Clear row and Empty states stay unchanged", () => {
  assert.ok(pageSource.includes("<Badge>{callOutcomeLabel(outcome)}</Badge>"), "active-filter Badge stays");
  assert.ok(pageSource.includes("Clear the filter"), "empty-state clear action stays");
  assert.ok(pageSource.includes("No calls match this filter"), "filtered empty title stays");
});
