import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ticket 06, seam: post-response side effects in server mutations
// (settings + agents actions). Catches: logging that blocks the mutation
// response. Misses: live after() timing — the node runner never imports these
// modules, so deferral structure and preserved outcomes are asserted on the
// real sources, and the dev-server runtime check covers behavior.
// Version-matched guide (Next docs: after): `after` schedules work after the
// response finishes — logging and analytics. Request-critical work stays
// awaited: the deployment enqueue result (job id + status) IS the save
// response, and revalidatePath stays pre-response so the navigation after a
// save never renders stale paths.
const here = dirname(fileURLToPath(import.meta.url));
const settingsSource = readFileSync(join(here, "actions.ts"), "utf8");
const agentsSource = readFileSync(
  join(here, "..", "agents", "actions.ts"),
  "utf8",
);

/** Log calls that run inline in the mutation instead of deferred via after(). */
function inlineLogCalls(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        /console\.(error|warn)\(/.test(line) && !line.includes("after("),
    );
}

test("settings logging runs after the response, not inside it", () => {
  assert.match(settingsSource, /from "next\/server"|from 'next\/server'/);
  assert.match(settingsSource, /\bafter\(/);
  // No bare console logging at statement level — every log site defers via
  // after() so failures to log can never delay or break the mutation.
  assert.deepEqual(inlineLogCalls(settingsSource), []);
  assert.ok(settingsSource.includes("[providers]"), "provider log kept");
  assert.ok(settingsSource.includes("[voice-prefs]"), "voice-prefs log kept");
});

test("agent-delete logging runs after the response, not inside it", () => {
  assert.match(agentsSource, /\bafter\(/);
  assert.deepEqual(inlineLogCalls(agentsSource), []);
  assert.ok(agentsSource.includes("[agent-delete]"), "delete log kept");
});

test("response-critical work stays awaited pre-response", () => {
  // The enqueue result (queued/attention + job id) drives the editor's
  // watcher and toasts — it is the response, so it stays awaited.
  assert.ok(
    agentsSource.includes("await enqueueDeployment"),
    "deployment enqueue stays awaited",
  );
  // Cache sweep stays pre-response: revalidating before returning keeps the
  // navigation that follows a save from rendering stale lists.
  assert.ok(agentsSource.includes("revalidatePath("), "agent paths still revalidated");
  assert.ok(settingsSource.includes("revalidatePath("), "settings paths still revalidated");
});
