import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (same approach as calls-index.test.ts): the repo
// has no jsdom/component-render setup, so option labels and the empty
// state are checked on the real source.
const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "phone-numbers.tsx"), "utf8");
const headerSource = readFileSync(join(dir, "sidebar-03", "utility-rows.tsx"), "utf8");

test("no raw sentinel ships in the Answered-by options", () => {
  assert.ok(!source.includes(">__unbound__<"), "sentinel never renders as label text");
  assert.ok(!source.includes(">{UNBOUND}<"), "sentinel value never renders raw");
  const labels = source.match(/Main reception agent answers/g) ?? [];
  assert.equal(labels.length, 3, "both option lists plus the closed-trigger label");
});

test("closed triggers render the human label, not the raw value", () => {
  // Base UI resolves <SelectValue /> text from mounted items; popup items
  // only mount while open, so the Select needs its `items` map to label a
  // closed trigger (verified live: "__unbound__" without it).
  const withItems = source.match(/items=\{agentItems\}/g) ?? [];
  assert.equal(withItems.length, 2, "add-form and row Selects both pass the items map");
});

test("add-number form hints when the default is the right choice", () => {
  assert.ok(source.includes("FieldDescription"), "hint uses the Field composition");
  // The hint wraps across a JSX line break ("unless a\n specific agent"),
  // so match the two halves rather than the joined sentence.
  assert.ok(
    source.includes("unless a") && source.includes("specific agent should pick up"),
    "hint says when to change the default",
  );
});

test("numbers empty state replaces the table, never a header-only table", () => {
  // DataTable idiom: with zero rows the frame holds the Empty on its own.
  assert.ok(source.includes("numbers.length === 0 ? (\n          <Empty>"), "Empty stands in for the table");
});

test("row Answered-by trigger meets the touch-target floor", () => {
  assert.ok(
    source.includes("min-h-11 w-44 sm:w-56"),
    "row trigger lifts h-8 toward the 44px floor",
  );
});

test("jobs row idle label matches nav and page title", () => {
  assert.ok(headerSource.includes('"Background jobs"'), "idle label is Background jobs");
});
