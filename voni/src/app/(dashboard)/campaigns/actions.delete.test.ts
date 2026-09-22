import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Same approach as agents/actions.delete.test.ts: the repo has no
// jsdom/component-render setup, so delete rails are asserted on the real
// server-action source text.
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "actions.ts"),
  "utf8",
);

test("delete refuses when the campaign is active", () => {
  assert.ok(source.includes("deleteCampaignAction"));
  assert.ok(source.includes('campaign.status === "active"'));
  assert.ok(source.includes("Pause the campaign first"));
});

test("delete nulls call history instead of erasing it", () => {
  const fn = source.slice(source.indexOf("export async function deleteCampaignAction"));
  assert.ok(fn.includes("update(calls)"));
  assert.ok(fn.includes("campaignId: null"));
  assert.ok(!fn.includes("delete(calls)"), "call history must survive");
  assert.ok(!fn.includes("delete(leads)"), "leads are shared, never deleted");
});

test("delete cancels in-flight imports looked up by input.campaignId", () => {
  const fn = source.slice(source.indexOf("export async function deleteCampaignAction"));
  // Imports never set relatedId — the lookup must read input.campaignId JSON.
  assert.ok(fn.includes("lead_csv_import") || fn.includes("campaignId"));
  assert.ok(fn.includes("->> 'campaignId'"));
  assert.ok(fn.includes("cancelRequested"));
  assert.ok(fn.includes("cancelled"));
});

test("job cleanup is by id, never by title", () => {
  const fn = source.slice(source.indexOf("export async function deleteCampaignAction"));
  assert.ok(fn.includes("delete(backgroundJobs)"));
  assert.ok(!fn.includes("ilike"), "title-ILIKE would erase other campaigns' jobs");
});

test("delete is org-scoped and revalidates both routes", () => {
  const fn = source.slice(source.indexOf("export async function deleteCampaignAction"));
  assert.ok(fn.includes("eq(campaigns.organizationId, ctx.organizationId)"));
  assert.ok(fn.includes('revalidatePath("/campaigns")'));
  assert.ok(fn.includes("revalidatePath(`/campaigns/${id}`)"));
});
