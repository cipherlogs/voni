import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The one surface /email's action results share, asserted where it is written:
 * the viewport is centred at the bottom on every breakpoint, and the outcome
 * toasts carry their artifact action and their urgency correctly.
 */

const viewport = readFileSync(new URL("./toast.tsx", import.meta.url), "utf8");
const feedback = readFileSync(
  new URL("../action-feedback.tsx", import.meta.url),
  "utf8",
);

test("the toast viewport is bottom-centred on every breakpoint", () => {
  const start = viewport.indexOf("function ToastViewport");
  const block = viewport.slice(start, viewport.indexOf("function Toast(", start));

  assert.match(block, /fixed inset-x-4 bottom-4/);
  assert.match(block, /mx-auto/, "centred in the width it is given");
  assert.match(block, /max-w-sm/, "keeps the width constraint");
  assert.doesNotMatch(block, /sm:right-4|sm:left-auto|sm:mx-0/, "no right-aligned override");
});

test("an error toast is announced urgently", () => {
  assert.match(
    feedback,
    /if \(state\.error\) \{[\s\S]*?type: "error",[\s\S]*?priority: "high",/,
  );
});

test("a success toast carries its timeout and artifact action", () => {
  assert.match(
    feedback,
    /toast\.add\(\{[\s\S]*?type: "success",[\s\S]*?timeout,[\s\S]*?actionProps: actionPropsFor\(action\),/,
  );
  assert.match(
    feedback,
    /window\.open\(action\.href, "_blank", "noopener,noreferrer"\)/,
    "a run action opens the workflow in a new tab",
  );
  assert.match(
    feedback,
    /navigator\.clipboard\.writeText\(command\)/,
    "a command action copies the exact line",
  );
});

test("the inline Alert and manual block are gone from the shared module", () => {
  assert.doesNotMatch(feedback, /export function FeedbackAlert|ManualRunFallback/);
  assert.doesNotMatch(feedback, /<Alert|<pre/);
});
