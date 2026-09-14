import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// NOTE: voni has no @testing-library/react / jsdom (see package.json), and
// the repo's test harness is node:test + tsx with no component-render setup.
// So instead of rendering Onboarding07, this test asserts on the real
// component source text — the exact markers, wiring, and class strings that
// ship to the DOM (same approach as wizard-timeline.test.tsx).
const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "onboarding-07.tsx"), "utf8");

test("progress meters render above the logs item, not inside a collapsible", () => {
  // Upstream layout: Progress section first, logs accordion item below it.
  assert.ok(source.includes("Progress"));
  assert.ok(source.includes("AccordionItem"));
  const progressIdx = source.indexOf("<Progress");
  const accordionIdx = source.indexOf("<Accordion");
  assert.ok(progressIdx !== -1 && accordionIdx !== -1);
  assert.ok(
    progressIdx < accordionIdx,
    "meters must render above the logs accordion",
  );
  // The old whole-block Collapsible wrapper is gone.
  assert.ok(!source.includes("Collapsible"));
  assert.ok(source.includes("use client"));
});

test("logs item starts collapsed by default", () => {
  assert.ok(source.includes("defaultOpen = false"));
  assert.ok(source.includes('defaultValue={defaultOpen ? ["logs"] : []}'));
  assert.ok(source.includes("Logs overview ({entries.length})"));
});

test("trigger shows the latest entry title as its summary", () => {
  assert.ok(source.includes("entries.at(-1)"));
  assert.ok(source.includes("latestTitle"));
});

test("deployment error is visible without expanding the logs", () => {
  // The error line lives outside the Accordion, driven by the last entry.
  const accordionIdx = source.indexOf("<Accordion");
  const errorLineIdx = source.indexOf('deploymentEntry?.state === "error"');
  assert.ok(errorLineIdx !== -1);
  assert.ok(
    errorLineIdx < accordionIdx,
    "error line must render above (outside) the collapsed panel",
  );
  assert.ok(source.includes("TriangleAlert"));
  assert.ok(source.includes("text-destructive"));
  assert.ok(
    source.includes("[&_[data-slot=progress-indicator]]:bg-destructive"),
    "failed meter fills destructive",
  );
});

test("meters map entry state: done 100, in-progress 45, queued 0", () => {
  assert.ok(source.includes("meterValue"));
  assert.ok(source.includes('if (state === "current") return 45'));
  assert.ok(source.includes('if (state === "neutral" || state === "upcoming") return 0'));
  assert.ok(source.includes("return 100"));
  assert.ok(source.includes("LoaderCircle"));
  assert.ok(source.includes("animate-spin"));
});

test("timeline rows keep the onboarding-06 idiom and project conventions", () => {
  assert.ok(source.includes("gap-x-3"));
  assert.ok(source.includes("gap-2.5"));
  assert.ok(!source.includes("space-x-"));
  assert.ok(!source.includes("space-y-"));
  assert.ok(!source.includes("asChild"));
  assert.ok(source.includes('from "@/lib/utils"'));
  assert.ok(!source.includes('from "cn"'));
  assert.ok(source.includes('from "lucide-react"'));
  // Rejections live in the file header as prose ("NOT adopted"), so scope
  // these to the shipped markup: no Tabler import, no full-height wrapper,
  // no demo animation timer.
  const markup = source.slice(source.indexOf("export default"));
  assert.ok(!markup.includes("@tabler/icons-react"));
  assert.ok(!markup.includes("min-h-dvh"));
  assert.ok(!markup.includes("setInterval"));
});
