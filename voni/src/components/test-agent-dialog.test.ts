import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Demo-cascade ticket 04: the test call is the tenant product's call and it
 * always runs the managed engine. There is no engine control, and no cascade
 * path to select by accident.
 */
const source = readFileSync(new URL("./test-agent-dialog.tsx", import.meta.url), "utf8");

test("the test-call dialog has no engine or Cascade control", () => {
  assert.doesNotMatch(source, /\bCascade\b/, "no Cascade control survives in the dialog");
  assert.doesNotMatch(source, /setEngine/, "no engine state exists to switch");
  assert.doesNotMatch(source, /engine=/, "the dialog never passes an engine prop");
});

test("a test call is inline, which is managed only", () => {
  assert.match(
    source,
    /mode=\{\{ kind: "inline", config, agentId, isDirty \}\}/,
    "the dialog opens the inline test call",
  );
});
