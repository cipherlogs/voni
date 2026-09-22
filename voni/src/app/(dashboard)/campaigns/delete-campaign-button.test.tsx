import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Source-text assertions (see agents/delete-agent-button.test.tsx for why):
// the confirm dialog contract, trigger composition, and house feedback
// patterns are checked on the real component source.
const dir = dirname(fileURLToPath(import.meta.url));
const buttonSource = readFileSync(
  join(dir, "delete-campaign-button.tsx"),
  "utf8",
);
const listSource = readFileSync(join(dir, "page.tsx"), "utf8");
const detailSource = readFileSync(join(dir, "[id]", "page.tsx"), "utf8");

test("delete dialog names the campaign and states the consequences", () => {
  assert.ok(buttonSource.includes("DialogTitle"));
  assert.ok(buttonSource.includes("DialogDescription"));
  assert.ok(buttonSource.includes("Delete campaign"));
  assert.ok(buttonSource.includes("cannot be undone"));
  assert.ok(buttonSource.includes("Past"));
  assert.ok(buttonSource.includes("call records and leads are kept"));
});

test("delete requires typing the campaign name (GitHub-style gate)", () => {
  assert.ok(buttonSource.includes("confirmation"));
  assert.ok(buttonSource.includes("Type"));
  assert.ok(buttonSource.includes("to enable deletion"));
  assert.ok(buttonSource.includes("trim() === name"));
  assert.ok(buttonSource.includes("disabled={!confirmed}"));
  assert.ok(buttonSource.includes('setConfirmation("")'));
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

test("delete failures stay visible in-dialog, inline-only (no error toast)", () => {
  assert.ok(buttonSource.includes('variant="destructive"'));
  assert.ok(buttonSource.includes("AlertDescription"));
  assert.ok(buttonSource.includes('type: "success"'));
  assert.ok(!buttonSource.includes('type: "error"'));
});

test("error replaces the consequence note instead of stacking", () => {
  // Regression for the double-Alert bug: the error Alert is the if-branch,
  // the consequence copy is the else-branch — never two red boxes at once.
  assert.ok(buttonSource.includes("{error ? ("));
  const errorIdx = buttonSource.indexOf("AlertDescription>{error}");
  const consequenceIdx = buttonSource.indexOf("its queue, and its job history");
  assert.ok(errorIdx !== -1 && consequenceIdx !== -1);
  assert.ok(
    errorIdx < consequenceIdx,
    "error Alert must be the if-branch, consequence the else-branch",
  );
  assert.ok(
    !buttonSource.includes(") : null}"),
    "error must have an else-branch, not render null",
  );
});

test("list row renders delete beside Open", () => {
  assert.ok(listSource.includes("CampaignDeleteButton"));
  assert.ok(listSource.includes("Open"));
});

test("detail page deletes with a redirect back to the list", () => {
  assert.ok(detailSource.includes("CampaignDeleteButton"));
  assert.ok(detailSource.includes('redirectTo="/campaigns"'));
});
