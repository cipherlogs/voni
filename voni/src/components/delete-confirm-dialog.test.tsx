import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (see agents/delete-agent-button.test.tsx for why):
// the shared confirm-dialog contract — trigger composition, typed-name gate,
// error-replaces-consequence, and house feedback patterns — is checked on the
// real component source. Wrapper tests only assert copy and wiring.
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "delete-confirm-dialog.tsx"),
  "utf8",
);

test("delete dialog contract: title, description slot, consequence slot", () => {
  assert.ok(source.includes("DeleteConfirmDialog"));
  assert.ok(source.includes("DialogTitle"));
  assert.ok(source.includes("DialogDescription"));
  assert.ok(source.includes("{description}"));
  assert.ok(source.includes("{consequence}"));
  assert.ok(source.includes("{notice}"));
});

test("delete requires typing the name (GitHub-style gate)", () => {
  assert.ok(source.includes("confirmation"));
  assert.ok(source.includes("to enable deletion"));
  assert.ok(source.includes("trim() === name"));
  assert.ok(source.includes("disabled={!confirmed}"));
  assert.ok(source.includes('setConfirmation("")'));
});

test("delete trigger composes via render= (Base UI), never asChild", () => {
  assert.ok(source.includes("render="));
  assert.ok(!source.includes("asChild"));
});

test("delete icon uses no sizing class and destructive confirm uses LoadingButton", () => {
  assert.match(source, /<Trash2( data-icon="inline-start")? \/>/);
  assert.ok(source.includes("LoadingButton"));
  assert.ok(source.includes('pendingText="Deleting…"'));
});

test("delete failures stay visible in-dialog, inline-only (no error toast)", () => {
  assert.ok(source.includes('variant="destructive"'));
  assert.ok(source.includes("AlertDescription"));
  assert.ok(source.includes('type: "success"'));
  assert.ok(!source.includes('type: "error"'));
});

test("error replaces the consequence note instead of stacking", () => {
  // The error Alert is the if-branch, the consequence slot the else-branch —
  // never two red boxes at once.
  assert.ok(source.includes("{error ? ("));
  const errorIdx = source.indexOf("AlertDescription>{error}");
  const consequenceIdx = source.indexOf("{consequence}");
  assert.ok(errorIdx !== -1 && consequenceIdx !== -1);
  assert.ok(
    errorIdx < consequenceIdx,
    "error Alert must be the if-branch, consequence the else-branch",
  );
  assert.ok(
    !source.includes(") : null}"),
    "error must have an else-branch, not render null",
  );
});

test("success toasts once and navigates", () => {
  assert.ok(source.includes("deleted.`"));
  assert.ok(source.includes("redirectTo"));
  assert.ok(source.includes("router.push"));
  assert.ok(source.includes("router.refresh"));
});
