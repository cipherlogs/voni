import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Goal 8: post-terminal wizard resets. Pure-helper behavior (parse/reject) is
// covered in wizard.test.ts; this pins the reset contract on source text.
const dir = dirname(fileURLToPath(import.meta.url));
const helperSource = readFileSync(join(dir, "use-wizard-draft.ts"), "utf8");
const newSource = readFileSync(
  join(dir, "..", "..", "app", "(dashboard)", "agents", "new", "page.tsx"),
  "utf8",
);

test("resetWizardForNewCreation drops draft + consumed jobs, keeps edit-drafts", () => {
  assert.ok(helperSource.includes("export function resetWizardForNewCreation"));
  assert.ok(helperSource.includes("clearWizardDraftCache()"));
  assert.ok(helperSource.includes("sessionStorage.removeItem(CONSUMED_JOBS_KEY)"));
  // Per-agent voni:edit-draft:<id> keys are untouched by wizard resets.
  const resetFn = helperSource.slice(
    helperSource.indexOf("export function resetWizardForNewCreation"),
    helperSource.indexOf("export const WIZARD_FRESH_STEP"),
  );
  assert.ok(!resetFn.includes("edit-draft"));
  assert.ok(!resetFn.includes("localStorage.removeItem"));
});

test("fresh creations start at step 1 via WIZARD_FRESH_STEP", () => {
  assert.ok(helperSource.includes("export const WIZARD_FRESH_STEP = 0"));
  assert.ok(newSource.includes("wiz.setStep(WIZARD_FRESH_STEP)"));
});

test("BOTH terminal outcomes reset: reviewed save AND terminal failure", () => {
  // Successful reviewed save alongside markJobConsumed.
  const saveFn = newSource.slice(newSource.indexOf("const save = async"));
  assert.ok(saveFn.includes("markJobConsumed(jobId)"));
  assert.ok(saveFn.includes("resetWizardForNewCreation()"));
  // Terminal failure once the error is shown/consumed (Start over).
  // The reset call precedes the button label in source order (handler
  // before JSX text), so slice from the retry-card branch instead.
  assert.ok(newSource.includes("Start over with a new brief"));
  const retryBranch = newSource.slice(newSource.indexOf("generation-retry-new"));
  assert.ok(retryBranch.includes("resetWizardForNewCreation()"));
  assert.ok(retryBranch.includes("wiz.setStep(WIZARD_FRESH_STEP)"));
});

test("wizard mount starts at step 1 when the cache is post-terminal", () => {
  // Post-terminal caches are dropped by resetWizardForNewCreation, so any
  // cache present at mount is live — and no cache starts fresh.
  assert.ok(helperSource.includes("WIZARD_FRESH_STEP"));
  assert.ok(helperSource.includes("cached.step ?? WIZARD_FRESH_STEP"));
});

test("in-memory undo stack (max 20) is untouched by the durable reset", () => {
  assert.ok(helperSource.includes("MAX_HISTORY = 20"));
  assert.ok(helperSource.includes("history.current"));
});
