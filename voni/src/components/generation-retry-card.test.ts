import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// NOTE: voni has no @testing-library/react / jsdom (see package.json), and
// the repo's test harness is node:test + tsx with no component-render setup.
// So like wizard-timeline.test.tsx this asserts on the real source text.
const dir = dirname(fileURLToPath(import.meta.url));
const cardSource = readFileSync(join(dir, "generation-retry-card.tsx"), "utf8");
const editSource = readFileSync(
  join(dir, "..", "app", "(dashboard)", "agents", "[id]", "edit-agent.tsx"),
  "utf8",
);
const newSource = readFileSync(
  join(dir, "..", "app", "(dashboard)", "agents", "new", "page.tsx"),
  "utf8",
);
const startSource = readFileSync(join(dir, "..", "lib", "jobs", "start.ts"), "utf8");

test("retry card adapts the blocks.so onboarding-02 StepCard idiom", () => {
  // Icon + title + description + action button, active-state surface.
  assert.ok(cardSource.includes("border-primary/30 bg-muted/50"));
  assert.ok(cardSource.includes("rounded-lg border"));
  assert.ok(cardSource.includes("size-7"));
  assert.ok(cardSource.includes("gap-3"));
  assert.ok(cardSource.includes("text-muted-foreground"));
});

test("retry card copy contract: didn't finish, retry action, review on completion", () => {
  // The card takes title/description as props (call sites own the copy via
  // jobErrorCopy); the contract pins the three beats in the call sites.
  assert.ok(editSource.includes("a completed draft appears here for review"));
  assert.ok(editSource.includes("Retry to start a fresh attempt"));
  assert.ok(newSource.includes("a completed draft appears here for review"));
  assert.ok(newSource.includes("Retry to start a fresh attempt"));
});

test("retry mints a FRESH key — never the stable per-brief key", () => {
  assert.ok(editSource.includes("`generation:retry:${crypto.randomUUID()}`"));
  assert.ok(newSource.includes("`generation:retry:${crypto.randomUUID()}`"));
  // The stable key stays for initial submits only.
  assert.ok(newSource.includes("generationIdempotencyKey(brief)"));
});

test("terminal generation rows never replay on the same key (start.ts)", () => {
  assert.ok(startSource.includes("getJobByIdempotencyKey"));
  assert.ok(startSource.includes('prior.status === "failed"'));
  assert.ok(startSource.includes('prior.status === "cancelled"'));
  assert.ok(startSource.includes('prior.status === "succeeded"'));
});

test("stub terminal failure shows ONLY the retry card — sections hide", () => {
  assert.ok(editSource.includes("generationTerminalFailure"));
  assert.ok(editSource.includes("{!generationTerminalFailure && !hideFormWhileGenerating ? ("));
});

test("cancelled stub failure keeps its cancelled copy, not the failure copy", () => {
  // new/page distinguishes cancelled from failed in the card title; the copy
  // comes from jobErrorCopy("cancelled") via terminalErrorCode.
  assert.ok(newSource.includes("Generation was cancelled"));
  assert.ok(newSource.includes("jobErrorCopy(terminalErrorCode)"));
});

test("retry card actions: LoadingButton retry + ghost View in Jobs, base icons", () => {
  assert.ok(cardSource.includes("LoadingButton"));
  assert.ok(cardSource.includes('pendingText="Starting…"'));
  assert.ok(cardSource.includes('variant="ghost"'));
  assert.ok(cardSource.includes("View in Jobs"));
  // Lucide icons, no sizing classes on the affordance icons.
  assert.ok(cardSource.includes("RotateCw"));
  assert.ok(cardSource.includes("CircleAlert"));
  assert.ok(!cardSource.includes("asChild"));
});
