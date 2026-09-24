import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The dialog contract (typed-name gate, trigger composition, feedback
// patterns, error-replaces-consequence) lives in the shared
// DeleteConfirmDialog and is tested in
// src/components/delete-confirm-dialog.test.tsx. This file asserts the
// campaign wrapper's copy and wiring — plus the list/detail page integration.
const dir = dirname(fileURLToPath(import.meta.url));
const buttonSource = readFileSync(
  join(dir, "delete-campaign-button.tsx"),
  "utf8",
);
const listSource = readFileSync(join(dir, "page.tsx"), "utf8");
const detailSource = readFileSync(join(dir, "[id]", "page.tsx"), "utf8");

test("delete delegates to the shared confirm dialog", () => {
  assert.ok(buttonSource.includes("DeleteConfirmDialog"));
  assert.ok(buttonSource.includes("confirmAction={deleteCampaignAction}"));
  // Contract lives in the shared component, not the wrapper.
  assert.ok(!buttonSource.includes("DialogContent"));
  assert.ok(!buttonSource.includes("useTransition"));
});

test("delete dialog names the campaign and states the consequences", () => {
  assert.ok(buttonSource.includes("Delete campaign"));
  assert.ok(buttonSource.includes("cannot be undone"));
  assert.ok(buttonSource.includes("its queue, and its job history"));
  assert.ok(buttonSource.includes("Past call"));
  assert.ok(buttonSource.includes("records and leads are kept"));
  assert.ok(buttonSource.includes('fieldLabel="Campaign name"'));
  assert.ok(buttonSource.includes('confirmLabel="Delete campaign"'));
});

test("delete trigger supports list and detail layouts", () => {
  assert.ok(buttonSource.includes("layout"));
  assert.ok(buttonSource.includes('label = "Delete campaign"'));
  assert.ok(buttonSource.includes("redirectTo"));
  assert.ok(buttonSource.includes("triggerLabel={label}"));
});

test("list row puts Open and Delete in the row menu", () => {
  assert.ok(listSource.includes("<RecordRowActions"));
  assert.ok(listSource.includes('kind="campaign"'));
});

test("detail page deletes with a redirect back to the list", () => {
  // Delete lives in the header "…" menu, which opens CampaignDeleteButton.
  assert.ok(detailSource.includes("<RecordRowActions"));
  assert.ok(detailSource.includes('redirectTo="/campaigns"'));
});
