import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ticket 06, seam: the campaign-detail server-to-client boundary
// (getCampaign -> CampaignQueue members). Catches: oversized member rows —
// the query selects exactly the columns QueueMember renders. Misses: wire
// bytes (runtime check). Same approach as campaign-queue.test.ts: no
// jsdom/component-render setup, so the projection is asserted on sources.
const here = dirname(fileURLToPath(import.meta.url));
const actionsSource = readFileSync(join(here, "actions.ts"), "utf8");
const queueSource = readFileSync(
  join(here, "..", "..", "..", "components", "campaign-queue.tsx"),
  "utf8",
);
const pageSource = readFileSync(join(here, "[id]", "page.tsx"), "utf8");

test("member rows select only the columns the queue renders", () => {
  const start = actionsSource.indexOf("export async function getCampaign");
  assert.ok(start >= 0, "getCampaign exists");
  // getCampaign is followed by the queueBulkSchema const (not another
  // export), so terminate there instead of at the next export.
  const end = actionsSource.indexOf("const queueBulkSchema", start);
  const fn = actionsSource.slice(start, end < 0 ? undefined : end);
  for (const column of [
    "campaignLeads.id",
    "campaignLeads.status",
    "campaignLeads.attempts",
    "campaignLeads.lastAttemptAt",
    "campaignLeads.lastOutcome",
    "campaignLeads.leadId",
    "leads.name",
    "leads.phone",
    "leads.consentStatus",
  ]) {
    assert.ok(fn.includes(column), `members select keeps ${column}`);
  }
  // lastOutcome moved server-side; nextAttemptAfter was selected but never
  // rendered — dropping it shrinks every queue row.
  assert.ok(!fn.includes("nextAttemptAfter"), "members select drops nextAttemptAfter");
});

test("queue member type carries only rendered fields", () => {
  const typeBlock = queueSource.slice(queueSource.indexOf("export type QueueMember"));
  const body = typeBlock.slice(0, typeBlock.indexOf("};"));
  assert.ok(!body.includes("nextAttemptAfter"), "QueueMember has no nextAttemptAfter");
  for (const field of [
    "status",
    "attempts",
    "lastAttemptAt",
    "lastOutcome",
    "leadId",
    "leadName",
    "phone",
    "consentStatus",
  ]) {
    assert.ok(body.includes(field), `QueueMember keeps ${field}`);
  }
});

test("campaign page keeps the same queue data and shape", () => {
  assert.ok(pageSource.includes("members={members}"), "queue still receives members");
  assert.ok(pageSource.includes("maxAttempts={campaign.maxAttempts}"));
  assert.ok(actionsSource.includes(".limit(200)"), "queue still capped at 200 rows");
  assert.ok(actionsSource.includes("orderBy(campaignLeads.createdAt)"), "queue order kept");
});
