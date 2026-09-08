import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for Task 1 (button cursor + TimelineBar sizing).
//
// NOTE: voni has no @testing-library/react / jsdom (see package.json), and
// the repo's test harness is node:test + tsx with no component-render setup.
// So instead of rendering TimelineBar, this test asserts on the real
// component source text — the exact class strings that ship to the DOM.
// It fails on the pre-fix source (no cursor-pointer on the TimelineBar
// Button, h-1.5 segment) and passes on the fixed source.
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

test("TimelineBar buttons carry cursor-pointer", () => {
  assert.match(
    timelineBarSource,
    /group flex cursor-pointer flex-col/,
    "TimelineBar Button className must include cursor-pointer",
  );
});

test("TimelineBar segment uses the enlarged h-2 sizing", () => {
  assert.match(
    timelineBarSource,
    /h-2 w-full rounded-full/,
    "TimelineBar segment span must use h-2",
  );
  assert.match(
    timelineBarSource,
    /md:h-2\.5/,
    "TimelineBar segment span must scale to md:h-2.5",
  );
  assert.doesNotMatch(
    timelineBarSource,
    /h-1\.5 w-full/,
    "pre-fix h-1.5 segment sizing must not remain in TimelineBar",
  );
});

test("shared Button base keeps cursor-pointer without leaking onto disabled state", () => {
  assert.match(
    buttonSource,
    /cursor-pointer/,
    "buttonVariants base must include cursor-pointer",
  );
  assert.match(
    buttonSource,
    /disabled:pointer-events-none/,
    "disabled buttons must keep pointer-events-none so the cursor never renders on disabled state",
  );
});
