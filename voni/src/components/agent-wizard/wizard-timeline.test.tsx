import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// NOTE: voni has no @testing-library/react / jsdom (see package.json), and
// the repo's test harness is node:test + tsx with no component-render setup.
// So instead of rendering TimelineBar, this test asserts on the real
// component source text — the exact class strings that ship to the DOM.
const dir = dirname(fileURLToPath(import.meta.url));
const timelineSource = readFileSync(join(dir, "wizard-timeline.tsx"), "utf8");
const buttonSource = readFileSync(join(dir, "..", "ui", "button.tsx"), "utf8");

const timelineBarSource = timelineSource.slice(
  timelineSource.indexOf("export function TimelineBar"),
);

assert.ok(
  timelineSource.includes("export function TimelineBar"),
  "precondition: TimelineBar exists in wizard-timeline.tsx",
);

test("TimelineBar is one button per step, equal width", () => {
  assert.ok(timelineBarSource.includes("WIZARD_STEPS"));
  assert.ok(timelineBarSource.includes("flex min-w-0 flex-1"));
  assert.ok(timelineBarSource.includes('aria-current={active ? "step" : undefined}'));
});

test("TimelineBar buttons are 56px minimum with one centered row", () => {
  assert.match(
    timelineBarSource,
    /min-h-14/,
    "step buttons must be at least 56px tall",
  );
  assert.doesNotMatch(
    timelineBarSource,
    /cursor-pointer/,
    "TimelineBar Button must not request the hand cursor; hover shows the native arrow like every shared Button",
  );
  assert.match(
    timelineBarSource,
    /justify-center/,
    "number and label share one centered row",
  );
});

test("TimelineBar shows no percentage or progress display", () => {
  assert.doesNotMatch(timelineBarSource, /Progress/);
  assert.doesNotMatch(timelineBarSource, /%/);
  assert.doesNotMatch(timelineSource, /TimelineRail/);
});

test("shared Button base uses the native arrow cursor, never the hand, without leaking onto disabled state", () => {
  assert.doesNotMatch(
    buttonSource,
    /cursor-pointer/,
    "buttonVariants base must not include cursor-pointer",
  );
  assert.match(
    buttonSource,
    /disabled:pointer-events-none/,
    "disabled buttons must keep pointer-events-none so the cursor never renders on disabled state",
  );
});
