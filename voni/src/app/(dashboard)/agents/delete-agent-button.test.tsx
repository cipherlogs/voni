import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (see actions.delete.test.ts for why): the confirm
// dialog contract, trigger composition, and house feedback patterns are
// checked on the real component source.
const dir = dirname(fileURLToPath(import.meta.url));
const buttonSource = readFileSync(join(dir, "delete-agent-button.tsx"), "utf8");
const pageSource = readFileSync(join(dir, "page.tsx"), "utf8");
const editSource = readFileSync(join(dir, "[id]", "edit-agent.tsx"), "utf8");

test("delete dialog names the agent and states the consequences", () => {
  assert.ok(buttonSource.includes("DialogTitle"));
  assert.ok(buttonSource.includes("DialogDescription"));
  assert.ok(buttonSource.includes("AssemblyAI"));
  assert.ok(buttonSource.includes("cannot be undone"));
});

test("delete requires typing the agent name (GitHub-style gate)", () => {
  // Type-to-confirm: an Input bound to a confirmation string gates the
  // destructive confirm until it exactly matches the agent name.
  assert.ok(buttonSource.includes("confirmation"));
  assert.ok(buttonSource.includes("Type"));
  assert.ok(buttonSource.includes("to enable deletion"));
  assert.ok(buttonSource.includes("trim() === name"));
  assert.ok(buttonSource.includes("disabled={!confirmed}"));
  assert.ok(buttonSource.includes("setConfirmation(\"\")"));
});

test("delete trigger composes via render= (Base UI), never asChild", () => {
  assert.ok(buttonSource.includes("render="));
  assert.ok(!buttonSource.includes("asChild"));
});

test("delete icon uses no sizing class and destructive confirm uses LoadingButton", () => {
  assert.match(buttonSource, /<Trash2( data-icon="inline-start")? \/>/);
  assert.ok(buttonSource.includes("LoadingButton"));
  assert.ok(buttonSource.includes('pendingText="Deleting…"'));
});

test("delete failures stay visible in-dialog and as a toast", () => {
  assert.ok(buttonSource.includes('variant="destructive"'));
  assert.ok(buttonSource.includes("AlertDescription"));
  assert.ok(buttonSource.includes('type: "error"'));
  assert.ok(buttonSource.includes('type: "success"'));
});

test("list row renders delete as a sibling above the stretched-link overlay", () => {
  assert.ok(pageSource.includes("AgentDeleteButton"));
  assert.ok(pageSource.includes("relative z-10"));
  // The job owns the row only while running — failed/cancelled and aged-out
  // (gen null) placeholders keep their delete button.
  assert.ok(pageSource.includes("gen?.running ? null"));
  assert.ok(!pageSource.includes("gen ? null"));
});

test("never-provisioned delete shortens copy but keeps the typed-name gate", () => {
  assert.ok(buttonSource.includes("neverProvisioned"));
  assert.ok(buttonSource.includes("No voice agent exists yet"));
  assert.ok(buttonSource.includes("not yet provisioned"));
  // Short copy only — the destructive confirm still requires typing the name.
  assert.ok(buttonSource.includes("disabled={!confirmed}"));
});

test("detail page deletes from the danger zone only, no footer delete or muted sentence", () => {
  // One delete affordance total: the bordered "Danger zone" section. The
  // footer-bar delete next to Save doubled the destructive affordance, so it
  // is gone — no footerSecondary prop, no muted sentence link.
  assert.ok(editSource.includes("AgentDeleteButton"));
  assert.ok(editSource.includes("Danger zone"));
  assert.ok(editSource.includes("danger-zone-heading"));
  assert.ok(!editSource.includes("footerSecondary"));
  assert.ok(editSource.includes('redirectTo="/agents"'));
  assert.ok(!editSource.includes("Done with this agent?"));
});
