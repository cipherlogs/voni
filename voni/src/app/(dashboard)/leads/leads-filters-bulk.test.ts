import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as lead-state-cell.test.ts): the repo
// has no jsdom/component-render setup, so chips, checkbox column, and the
// bulk server action are checked on the real sources.
const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "page.tsx"), "utf8");
const actionsSource = readFileSync(join(dir, "actions.ts"), "utf8");
const chipsSource = readFileSync(
  join(dir, "..", "..", "..", "components", "filter-chips.tsx"),
  "utf8",
);
const bulkSource = readFileSync(
  join(dir, "..", "..", "..", "components", "leads-bulk-bar.tsx"),
  "utf8",
);

test("leads chips reuse the existing ?stage= params", () => {
  assert.ok(pageSource.includes("leadsChips"), "leads chips helper exists");
  assert.ok(pageSource.includes("/leads?stage=worked"), "Worked chip reuses ?stage=");
  assert.ok(pageSource.includes("/leads?stage=booked"), "Booked chip reuses ?stage=");
  assert.ok(pageSource.includes("/leads?stage=handoff"), "Handoff chip reuses ?stage=");
});

test("leads chips resolve inside a Suspense leaf above the Card, never the shell or the table", () => {
  const shell = pageSource.slice(
    pageSource.indexOf("export default function LeadsPage"),
  );
  assert.ok(!shell.includes("await searchParams"), "shell never awaits searchParams");
  // A <nav> child of <table> is invalid HTML (hydration error) — the chips
  // leaf renders between the header and the Card, and the rows leaf carries
  // only TableBody rows.
  assert.ok(shell.includes("<LeadsChips"), "chips render in a shell Suspense leaf");
  const leaf = pageSource.slice(
    pageSource.indexOf("async function LeadsChips"),
    pageSource.indexOf("export default function LeadsPage"),
  );
  assert.ok(leaf.includes("<FilterChips"), "chips mount inside the chips leaf");
  const rowsLeaf = pageSource.slice(
    pageSource.indexOf("async function LeadsRows"),
    pageSource.indexOf("async function LeadsChips"),
  );
  assert.ok(!rowsLeaf.includes("<FilterChips"), "rows leaf carries no nav");
});

test("chips are shadcn Button outline/ghost with render=<Link>, active gets aria-current + Badge dot", () => {
  assert.ok(chipsSource.includes('render={<Link href='), "Base UI render= composition");
  assert.ok(chipsSource.includes('"outline"'), "active chip is outline");
  assert.ok(chipsSource.includes('"ghost"'), "inactive chips are ghost");
  assert.ok(chipsSource.includes('aria-current'), "active chip exposes aria-current");
  assert.ok(chipsSource.includes("<Badge"), "active chip carries a Badge dot");
  assert.ok(chipsSource.includes("<nav"), "chips live in labelled nav land");
});

test("existing Badge+Clear row and Empty states stay unchanged", () => {
  assert.ok(pageSource.includes("<Badge>{stageFilterLabel(stage)}</Badge>"), "active-filter Badge stays");
  assert.ok(pageSource.includes("Clear the filter"), "empty-state clear action stays");
  assert.ok(pageSource.includes("No leads match this filter"), "filtered empty title stays");
});

test("leads table has a Checkbox first column with select-all over visible rows", () => {
  assert.ok(pageSource.includes("LeadsSelectCell"), "per-row checkbox island");
  assert.ok(pageSource.includes("<LeadsSelectAll"), "header select-all island");
  assert.ok(pageSource.includes("<LeadsSelection>"), "selection wraps the table in the shell");
  const shell = pageSource.slice(
    pageSource.indexOf("export default function LeadsPage"),
  );
  assert.ok(!shell.includes("await searchParams"), "selection wrapper never reads the URL");
  assert.ok(
    bulkSource.includes("Select lead ${name"),
    'per-row aria-label names the lead ("Select lead {name}")',
  );
  assert.ok(
    bulkSource.includes("Select all ${visible.length} visible leads"),
    "select-all labels the visible-row scope",
  );
});

test("bulk bar: count + raw-stage Select + LoadingButton Apply, alert on failure, toast + refresh on success", () => {
  assert.ok(bulkSource.includes("} selected"), "bar shows N selected");
  assert.ok(bulkSource.includes("<Select"), "stage Select present");
  const selectBlock = bulkSource.slice(bulkSource.indexOf("<Select"));
  assert.ok(!selectBlock.includes("worked"), "derived aliases excluded from the Select options");
  assert.ok(bulkSource.includes("<LoadingButton"), "Apply uses LoadingButton");
  assert.ok(bulkSource.includes("Applying…"), "Apply names its pending state");
  assert.ok(bulkSource.includes('<Alert variant="destructive"'), "inline Alert on failure");
  assert.ok(bulkSource.includes("toast.add"), "Base UI toast on success");
  assert.ok(bulkSource.includes("router.refresh()"), "success refreshes the list");
});

test("bulk stage action is one org-scoped UPDATE, ids capped at 200, aliases rejected", () => {
  const fn = actionsSource.slice(
    actionsSource.indexOf("export async function bulkLeadsStageAction"),
  );
  assert.ok(fn.includes("eq(leads.organizationId"), "org scope on read and write");
  assert.ok(fn.includes(".update(leads)"), "single UPDATE");
  assert.ok(actionsSource.includes("max(200)"), "ids capped at the visible 200");
  assert.ok(actionsSource.includes("RESERVED_STAGE_ALIASES"), "derived aliases guarded");
  assert.ok(
    fn.includes("curated filter, not a pipeline stage"),
    "alias rejection names the reason",
  );
  assert.ok(fn.includes('revalidatePath("/leads")'), "list revalidates after the move");
});
