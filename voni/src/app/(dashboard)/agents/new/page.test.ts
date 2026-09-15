import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// NOTE: voni has no @testing-library/react / jsdom (see package.json), and
// the repo's test harness is node:test + tsx with no component-render setup.
// So instead of rendering the draft gate, this test asserts on the real page
// source text — the exact props and classes that ship to the DOM. Same seam
// as wizard-timeline.test.tsx and shared-ui.test.ts.
const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "page.tsx"), "utf8");

const gateSource = pageSource.slice(
  pageSource.indexOf('title="Continue draft?"'),
  pageSource.indexOf("if (minimalWait)"),
);

assert.ok(
  gateSource.includes('title="Continue draft?"'),
  "precondition: draft gate exists in agents/new page",
);

test("draft gate offers continue and discard as equal boxed actions", () => {
  assert.ok(gateSource.includes("Continue draft"));
  assert.ok(gateSource.includes("Discard and start fresh"));
  // Discard is a visibly boxed outlined action, not a borderless ghost, so
  // its hovered frame matches the solid continue action beside it.
  assert.ok(gateSource.includes('variant="outline"'));
  assert.ok(!gateSource.includes('variant="ghost"'));
});

test("draft gate actions share one size with no cursor overrides", () => {
  // Both actions stack full-width on narrow screens and sit side by side at
  // one shared size on wide screens; neither sets an explicit size prop.
  assert.strictEqual(
    gateSource.split("w-full sm:w-auto").length - 1,
    2,
    "continue and discard must share the same responsive sizing classes",
  );
  assert.ok(!gateSource.includes("size="));
  // Cursor comes from the shared Button base (native arrow); the gate adds
  // no cursor classes of its own.
  assert.ok(!gateSource.includes("cursor-"));
});

test("draft gate preserves resume and discard behaviors", () => {
  assert.ok(gateSource.includes("setDraftGateOpen(false)"));
  assert.ok(gateSource.includes("clearWizardDraftCache()"));
  assert.ok(gateSource.includes("wiz.setStep(WIZARD_FRESH_STEP)"));
});

test("draft gate keeps native button roles and shared focus styling", () => {
  // Both actions are real buttons (roles/names inherited, not re-implemented)…
  assert.strictEqual(
    gateSource.split('type="button"').length - 1,
    2,
    "continue and discard must both be native buttons",
  );
  // …and the gate adds no focus or touch-target overrides, so focus rings
  // and tap sizes keep coming from the shared Button base unchanged.
  assert.ok(!gateSource.includes("focus-"));
  assert.ok(!gateSource.includes("pointer-coarse"));
  assert.ok(!gateSource.includes("min-h-"));
});
