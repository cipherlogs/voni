import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// NOTE: voni has no @testing-library/react / jsdom (see package.json), and
// the repo's test harness is node:test + tsx with no component-render setup.
// So like wizard-timeline.test.tsx this asserts on the real component source
// text — the exact contracts that ship to the DOM.
const dir = dirname(fileURLToPath(import.meta.url));
const pillSource = readFileSync(join(dir, "unsaved-pill.tsx"), "utf8");
const editSource = readFileSync(
  join(dir, "..", "app", "(dashboard)", "agents", "[id]", "edit-agent.tsx"),
  "utf8",
);

test("UnsavedPill binds to an isDirty boolean and announces politely", () => {
  assert.ok(pillSource.includes("isDirty: boolean"));
  assert.ok(pillSource.includes('aria-live="polite"'));
  assert.ok(pillSource.includes("Unsaved changes"));
});

test("UnsavedPill is informational only — Save/Discard stay in the footer", () => {
  // No action affordances: no buttons, no click handlers, no Save/Discard
  // labels in the rendered output. (The words appear in comments only —
  // assert on markup tokens, not prose.)
  assert.ok(!pillSource.includes("<Button"));
  assert.ok(!pillSource.includes("<button"));
  assert.ok(!pillSource.includes("onClick"));
  assert.ok(!pillSource.includes("render="));
});

test("UnsavedPill composes installed Badge + the shared StatusDot", () => {
  assert.ok(pillSource.includes("Badge"));
  assert.ok(pillSource.includes('variant="secondary"'));
  // One status idiom app-wide: the dot comes from StatusDot, not a hand-built span.
  assert.ok(pillSource.includes('<StatusDot tone="warning"'));
});

test("UnsavedPill floats without reserving space", () => {
  // Zero-height sticky layer: never shifts the column, never viewport-fixed.
  // Under the phone header (top-14); top-4 on desktop, which has no top bar.
  assert.ok(pillSource.includes("sticky top-14 z-20 flex h-0"));
  assert.ok(pillSource.includes("md:top-4"));
  assert.ok(pillSource.includes("invisible"));
  assert.doesNotMatch(pillSource, /"(?:[^"]*\s)?fixed(?:\s[^"]*)?"/);
});

test("edit-agent renders the pill bound to the snapshot isDirty", () => {
  assert.ok(editSource.includes("UnsavedPill"));
  assert.ok(editSource.includes("<UnsavedPill isDirty={isDirty} />"));
  // Bound to the existing JSON-compare snapshot: shows on dirty, hides on
  // save (savedSnapshot update + cache clear).
  assert.ok(editSource.includes("setSavedSnapshot(JSON.stringify({ name: nextName, config: nextConfig }))"));
  // beforeunload guard + restored-draft Alert unchanged.
  assert.ok(editSource.includes("beforeunload"));
  assert.ok(editSource.includes("Unsaved edits restored"));
});

test("edit-agent imports no overlay or custom-markup stand-ins for the pill", () => {
  assert.ok(!pillSource.includes("asChild"));
});
