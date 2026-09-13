import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db/index";
import { agents, campaignLeads, campaigns, leads } from "../src/lib/db/schema";
import {
  nextDialTarget,
  recordDialOutcome,
  releaseDialClaim,
  requeueStaleClaims,
} from "../src/lib/campaigns/dispatch";

/**
 * Integration check for the outbound dispatcher (plan Day 7-8).
 *
 * The claim query is raw SQL — a single-statement UPDATE with a
 * FOR UPDATE SKIP LOCKED subquery, and a CASE-driven outcome update that reads
 * the campaign's caps through a join. None of that is covered by typecheck or by
 * the pure-function unit tests, and all of it decides whether a real person gets
 * phoned twice. So it runs against the real database, in a throwaway
 * organization that is deleted in `finally`.
 */

const organizationId = `dispatch-test-${crypto.randomUUID()}`;
let agentId = "";
let campaignId = "";
const leadIds: string[] = [];

/** Monday 10:00 Dubai — inside the default window. */
const insideWindow = new Date("2026-09-07T06:00:00Z");
/** Monday 04:00 Dubai — before it opens. */
const outsideWindow = new Date("2026-09-07T00:00:00Z");

const window = {
  start: "09:00",
  end: "18:00",
  timezone: "Asia/Dubai",
  daysOfWeek: [1, 2, 3, 4, 5, 6],
};

async function addLead(phone: string, consentStatus: string) {
  const [lead] = await db
    .insert(leads)
    .values({ organizationId, phone, consentStatus, source: "dispatch-test" })
    .returning({ id: leads.id });
  leadIds.push(lead.id);
  await db.insert(campaignLeads).values({ campaignId, leadId: lead.id });
  return lead.id;
}

async function stateOf(leadId: string) {
  const [row] = await db
    .select({
      status: campaignLeads.status,
      attempts: campaignLeads.attempts,
      nextAttemptAfter: campaignLeads.nextAttemptAfter,
      lastOutcome: campaignLeads.lastOutcome,
    })
    .from(campaignLeads)
    .where(eq(campaignLeads.leadId, leadId))
    .limit(1);
  return row;
}

async function claimIdFor(leadId: string) {
  const [row] = await db
    .select({ id: campaignLeads.id })
    .from(campaignLeads)
    .where(eq(campaignLeads.leadId, leadId))
    .limit(1);
  return row.id;
}

try {
  agentId = (
    await db
      .insert(agents)
      .values({
        organizationId,
        name: "Dispatch test",
        config: {},
        // The dispatcher refuses to hand out leads for an undeployed agent, so
        // this has to look published.
        assemblyaiAgentId: `test-agent-${crypto.randomUUID()}`,
      })
      .returning({ id: agents.id })
  )[0].id;

  campaignId = (
    await db
      .insert(campaigns)
      .values({
        organizationId,
        agentId,
        name: "Dispatch test campaign",
        callingWindow: window,
        consentPolicy: { require: "granted" },
        maxAttempts: 2,
        retryAfterMinutes: 60,
        status: "draft",
      })
      .returning({ id: campaigns.id })
  )[0].id;

  const granted = await addLead("+971500000901", "granted");
  const unknown = await addLead("+971500000902", "unknown");
  const revoked = await addLead("+971500000903", "revoked");

  // --- A draft campaign is not work ---------------------------------------
  let decision = await nextDialTarget(organizationId, "preview", insideWindow);
  assert.equal(decision.status, "idle", "a draft campaign must not dial");
  assert.match(
    decision.status === "idle" ? decision.reason : "",
    /No active campaigns/,
    "an idle runner must speak in operator sentences",
  );

  await db
    .update(campaigns)
    .set({ status: "active" })
    .where(eq(campaigns.id, campaignId));

  // --- The calling window gates, and says so -------------------------------
  decision = await nextDialTarget(organizationId, "preview", outsideWindow);
  assert.equal(decision.status, "idle", "must not dial outside the window");
  assert.match(
    decision.status === "idle" ? decision.reason : "",
    /outside 09:00-18:00/,
    "an idle runner must be told why",
  );

  // --- Consent filters in SQL, not just in the UI --------------------------
  decision = await nextDialTarget(organizationId, "preview", insideWindow);
  assert.equal(decision.status, "dial");
  assert.equal(
    decision.status === "dial" ? decision.target.leadId : "",
    granted,
    "consent policy 'granted' must skip unknown and revoked",
  );
  assert.equal(decision.status === "dial" ? decision.target.attempt : 0, 1);

  // --- Preview mutates nothing ---------------------------------------------
  assert.deepEqual(
    { status: (await stateOf(granted)).status, attempts: (await stateOf(granted)).attempts },
    { status: "queued", attempts: 0 },
    "preview must not consume an attempt or claim the lead",
  );

  // --- Claiming is atomic and consumes exactly one attempt -----------------
  const claimed = await nextDialTarget(organizationId, "claim", insideWindow);
  assert.equal(claimed.status, "dial");
  assert.equal(claimed.status === "dial" ? claimed.target.leadId : "", granted);
  assert.equal(claimed.status === "dial" ? claimed.target.attempt : 0, 1);
  let state = await stateOf(granted);
  assert.equal(state.status, "dialing");
  assert.equal(state.attempts, 1);

  // --- One bridge, one call: no second dial while one is in flight ---------
  const concurrent = await nextDialTarget(organizationId, "claim", insideWindow);
  assert.equal(concurrent.status, "idle", "must not dial two calls at once");
  assert.match(
    concurrent.status === "idle" ? concurrent.reason : "",
    /already in progress — the next lead dials when it ends/,
    "an idle runner must speak in operator sentences",
  );

  // --- A no-answer requeues with backoff, and is not due yet ---------------
  const claimId = await claimIdFor(granted);
  let outcome = await recordDialOutcome(organizationId, claimId, "no_answer");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "queued", "attempt 1 of 2 must return to the queue");
  state = await stateOf(granted);
  assert.ok(state.nextAttemptAfter, "backoff must be scheduled");
  assert.ok(
    state.nextAttemptAfter!.getTime() > Date.now() + 30 * 60_000,
    "backoff must respect retry_after_minutes",
  );
  decision = await nextDialTarget(organizationId, "preview", insideWindow);
  assert.equal(decision.status, "idle", "a lead in backoff is not due");

  // --- Exhaustion retires the lead rather than dialling forever ------------
  await db
    .update(campaignLeads)
    .set({ nextAttemptAfter: null })
    .where(eq(campaignLeads.id, claimId));
  const second = await nextDialTarget(organizationId, "claim", insideWindow);
  assert.equal(second.status, "dial");
  assert.equal(second.status === "dial" ? second.target.attempt : 0, 2);
  outcome = await recordDialOutcome(organizationId, claimId, "no_answer");
  assert.equal(outcome.status, "exhausted", "attempt 2 of 2 must exhaust the lead");
  decision = await nextDialTarget(organizationId, "preview", insideWindow);
  assert.equal(decision.status, "idle", "an exhausted lead is not work");

  // --- A relaxed consent policy admits `unknown` ---------------------------
  await db
    .update(campaigns)
    .set({ consentPolicy: { require: "not_revoked" } })
    .where(eq(campaigns.id, campaignId));
  decision = await nextDialTarget(organizationId, "preview", insideWindow);
  assert.equal(decision.status, "dial");
  assert.equal(
    decision.status === "dial" ? decision.target.leadId : "",
    unknown,
    "not_revoked must admit unknown consent",
  );

  // --- `revoked` is never dialled, under any policy ------------------------
  const revokedClaim = await claimIdFor(revoked);
  await db
    .update(campaignLeads)
    .set({ status: "queued" })
    .where(eq(campaignLeads.id, revokedClaim));
  for (let i = 0; i < 4; i++) {
    const next = await nextDialTarget(organizationId, "claim", insideWindow);
    if (next.status === "dial") {
      assert.notEqual(next.target.leadId, revoked, "a revoked lead must never be dialled");
      await recordDialOutcome(organizationId, await claimIdFor(next.target.leadId), "answered");
    }
  }
  assert.equal((await stateOf(revoked)).status, "queued", "revoked stays untouched");

  // --- `answered` retires the lead -----------------------------------------
  assert.equal((await stateOf(unknown)).status, "reached");

  // --- A crashed runner's claim is recovered, not wedged forever -----------
  await db
    .update(campaignLeads)
    .set({
      status: "dialing",
      lastAttemptAt: new Date(Date.now() - 60 * 60_000),
      attempts: 0,
    })
    .where(eq(campaignLeads.id, revokedClaim));
  const requeued = await requeueStaleClaims(organizationId);
  assert.equal(requeued, 1, "a stalled dial must be requeued");
  assert.equal((await stateOf(revoked)).status, "queued");

  // --- `cancelled` hands the attempt back ----------------------------------
  await db
    .update(campaignLeads)
    .set({ status: "dialing", attempts: 1 })
    .where(eq(campaignLeads.id, revokedClaim));
  await releaseDialClaim(organizationId, revokedClaim, "dial cancelled");
  state = await stateOf(revoked);
  assert.equal(state.status, "queued");
  assert.equal(state.attempts, 0, "a dial that never reached the carrier costs no attempt");

  // --- Another workspace cannot report outcomes into this queue ------------
  const foreign = await recordDialOutcome(
    `someone-else-${crypto.randomUUID()}`,
    claimId,
    "answered",
  );
  assert.equal(foreign.ok, false, "outcome reports must be organization-scoped");

  console.log(
    JSON.stringify({
      draftCampaign: "not dialled",
      callingWindow: "enforced with a reason",
      consentPolicy: "enforced in SQL",
      preview: "no mutation",
      claim: "atomic, one attempt",
      concurrency: "one call at a time",
      backoff: "respected",
      exhaustion: "retires the lead",
      revokedConsent: "never dialled",
      staleClaim: "requeued",
      cancelledDial: "attempt refunded",
      crossOrgOutcome: "rejected",
    }),
  );
} finally {
  if (campaignId) {
    await db.delete(campaignLeads).where(eq(campaignLeads.campaignId, campaignId));
    await db.delete(campaigns).where(eq(campaigns.id, campaignId));
  }
  if (leadIds.length) await db.delete(leads).where(inArray(leads.id, leadIds));
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  // Belt and braces: nothing may survive under the throwaway organization.
  await db.execute(sql`DELETE FROM leads WHERE organization_id = ${organizationId}`);
}
