import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The dialog contract (typed-name gate, trigger composition, feedback
// patterns, error-replaces-consequence) lives in the shared
// DeleteConfirmDialog and is tested in
// src/components/delete-confirm-dialog.test.tsx. This file asserts the agent
// wrapper's copy and wiring — plus the list/detail page integration.
const dir = dirname(fileURLToPath(import.meta.url));
const buttonSource = readFileSync(join(dir, "delete-agent-button.tsx"), "utf8");
const pageSource = readFileSync(join(dir, "page.tsx"), "utf8");
const editSource = readFileSync(join(dir, "[id]", "edit-agent.tsx"), "utf8");

test("delete delegates to the shared confirm dialog", () => {
  assert.ok(buttonSource.includes("DeleteConfirmDialog"));
  assert.ok(buttonSource.includes("confirmAction={deleteAgentAction}"));
  // Contract lives in the shared component, not the wrapper.
  assert.ok(!buttonSource.includes("DialogContent"));
  assert.ok(!buttonSource.includes("useTransition"));
});

test("delete dialog names the agent and states the consequences", () => {
  assert.ok(buttonSource.includes("AssemblyAI"));
  assert.ok(buttonSource.includes("cannot be undone"));
  assert.ok(buttonSource.includes('fieldLabel="Agent name"'));
  assert.ok(buttonSource.includes('confirmLabel="Delete agent"'));
});

test("delete trigger supports list and detail layouts", () => {
  assert.ok(buttonSource.includes("layout"));
  assert.ok(buttonSource.includes('label = "Delete agent"'));
  assert.ok(buttonSource.includes("redirectTo"));
  assert.ok(buttonSource.includes("triggerLabel={label}"));
});

test("list row renders delete beside Open in the action cell, no stretched link", () => {
  assert.ok(pageSource.includes("AgentDeleteButton"));
  // The table idiom has no stretched-link overlay — rows navigate only via
  // the explicit Open button — so the Card-era stacking workaround is gone.
  assert.ok(!pageSource.includes("before:absolute before:inset-0"));
  assert.ok(!pageSource.includes("relative z-10"));
  // The job owns the row only while running — failed/cancelled and aged-out
  // (gen null) placeholders keep their delete button.
  assert.ok(pageSource.includes("gen?.running ? null"));
  assert.ok(!pageSource.includes("gen ? null"));
});

test("never-provisioned delete shortens copy but keeps the delete flow", () => {
  assert.ok(buttonSource.includes("neverProvisioned"));
  assert.ok(buttonSource.includes("No voice agent exists yet"));
  assert.ok(buttonSource.includes("not yet provisioned"));
  // Short copy only — the destructive confirm still goes through the shared
  // typed-name gate.
  assert.ok(buttonSource.includes("DeleteConfirmDialog"));
});

test("bridge default carries a blocking note", () => {
  assert.ok(buttonSource.includes("isBridgeAgent"));
  assert.ok(buttonSource.includes("platform bridge default"));
  assert.ok(buttonSource.includes("notice={"));
});

test("detail page deletes from the footer, no danger zone", () => {
  // One delete affordance total: the footer secondary slot. The bordered
  // "Danger zone" section is gone — no section heading, no muted sentence
  // link.
  assert.ok(editSource.includes("AgentDeleteButton"));
  assert.ok(editSource.includes("footerSecondary"));
  assert.ok(editSource.includes('redirectTo="/agents"'));
  assert.ok(!editSource.includes("Danger zone"));
  assert.ok(!editSource.includes("danger-zone-heading"));
  assert.ok(!editSource.includes("Done with this agent?"));
});
