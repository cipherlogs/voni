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
  // Imports never set relatedId — the lookup must read input.campaignId JSON,
  // scoped to the import kind so unrelated jobs are never touched.
  assert.ok(fn.includes("lead_csv_import"));
  assert.ok(fn.includes('eq(backgroundJobs.kind, "lead_csv_import")'));
  assert.ok(fn.includes("->> 'campaignId'"));
  assert.ok(fn.includes("eq(backgroundJobs.relatedId, id)"));
  // Cancel semantics live in the shared rail; the action wires it.
  assert.ok(fn.includes("cancelLinkedJobs"));
});

test("delete re-discovers imports enqueued during the delete", () => {
  const fn = source.slice(source.indexOf("export async function deleteCampaignAction"));
  // A fresh sweep (not the frozen pre-cancel set) must run after call
  // history is preserved and before the campaign row disappears.
  const nullCallsIdx = fn.indexOf("update(calls)");
  const sweepIdx = fn.indexOf("freshRows");
  const campaignDeleteIdx = fn.indexOf("delete(campaigns)");
  assert.ok(sweepIdx > nullCallsIdx, "sweep must run after history is preserved");
  assert.ok(
    sweepIdx < campaignDeleteIdx,
    "sweep must run before the campaign row is deleted",
  );
  const sweep = fn.slice(sweepIdx, campaignDeleteIdx);
  assert.ok(
    sweep.includes("cancelFreshLinkedJobs"),
    "sweep must re-cancel through the shared rail",
  );
  assert.ok(
    sweep.indexOf("deleteTerminalLinkedJobs") >
      sweep.indexOf("cancelFreshLinkedJobs"),
    "terminal hard-delete must run after the fresh cancel pass",
  );
});

test("job cleanup is by id, never by title", () => {
  const fn = source.slice(source.indexOf("export async function deleteCampaignAction"));
  assert.ok(fn.includes("deleteTerminalLinkedJobs"));
  assert.ok(fn.includes("sweepIds"), "hard-delete runs over the sweep union");
  assert.ok(!fn.includes("ilike"), "title-ILIKE would erase other campaigns' jobs");
});

test("delete is org-scoped and revalidates both routes", () => {
  const fn = source.slice(source.indexOf("export async function deleteCampaignAction"));
  assert.ok(fn.includes("eq(campaigns.organizationId, ctx.organizationId)"));
  assert.ok(fn.includes('revalidatePath("/campaigns")'));
  assert.ok(fn.includes("revalidatePath(`/campaigns/${id}`)"));
});
