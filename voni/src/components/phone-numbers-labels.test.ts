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
const headerSource = readFileSync(join(dir, "app-header.tsx"), "utf8");

test("no raw sentinel ships in the Answered-by options", () => {
  assert.ok(!source.includes(">__unbound__<"), "sentinel never renders as label text");
  assert.ok(!source.includes(">{UNBOUND}<"), "sentinel value never renders raw");
  const labels = source.match(/Main reception agent answers/g) ?? [];
  assert.equal(labels.length, 3, "both option lists plus the closed-trigger label");
});

test("closed triggers render the human label, not the raw value", () => {
  // Base UI resolves <SelectValue /> text from mounted items; popup items
  // only mount while open, so a bare <SelectValue /> falls back to the raw
  // value on the closed trigger (verified live: "__unbound__"). A
  // value-to-label function child renders the label with no mounted items.
  const valueRenders = source.match(/<SelectValue>\{agentLabel\}<\/SelectValue>/g) ?? [];
  assert.equal(valueRenders.length, 2, "add-form and row triggers both use agentLabel");
  assert.ok(!source.includes("<SelectValue />"), "no bare SelectValue left");
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

test("numbers empty state has breathing room", () => {
  assert.ok(source.includes("p-8 text-center"), "padded empty cell, not cramped");
  assert.ok(
    !source.includes("h-32 text-center"),
    "no fixed-height cramped empty cell",
  );
});

test("row Answered-by trigger meets the touch-target floor", () => {
  assert.ok(
    source.includes("min-h-11 w-56"),
    "row trigger lifts h-8 toward the 44px floor",
  );
});

test("header idle label matches nav and page title", () => {
  assert.ok(headerSource.includes(': "Background jobs"}'), "idle label is Background jobs");
  assert.ok(!headerSource.includes(': "Jobs"}'), 'no short "Jobs" label left');
});
