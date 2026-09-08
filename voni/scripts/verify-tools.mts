import assert from "node:assert/strict";
import { and, count, eq } from "drizzle-orm";
import { db } from "../src/lib/db/index";
import {
  agents,
  appointments,
  calls,
  followUps,
  leads,
  properties,
  toolCallLogs,
} from "../src/lib/db/schema";
import {
  executeTool,
  resolveCallContext,
  resolveTestContext,
  type ResolvedToolContext,
} from "../src/lib/tools/execute";

const organizationId = `tool-test-${crypto.randomUUID()}`;
let leadId = "";
let callId = "";
let agentId = "";
let propertyId = "";
const schedule = {
  timezone: "Asia/Dubai",
  weekly: {
    sunday: [{ start: "10:00", end: "18:00" }],
    monday: [{ start: "10:00", end: "18:00" }],
    tuesday: [{ start: "10:00", end: "18:00" }],
    wednesday: [{ start: "10:00", end: "18:00" }],
    thursday: [{ start: "10:00", end: "18:00" }],
  },
};

try {
  leadId = (await db
    .insert(leads)
    .values({ organizationId, phone: "+971500000001", source: "tool-test" })
    .returning({ id: leads.id }))[0].id;
  callId = (await db
    .insert(calls)
    .values({
      leadId,
      direction: "inbound",
      telnyxCallControlId: `test-${crypto.randomUUID()}`,
    })
    .returning({ id: calls.id }))[0].id;
  agentId = (await db
    .insert(agents)
    .values({ organizationId, name: "Tool test", config: {} })
    .returning({ id: agents.id }))[0].id;
  propertyId = (await db
    .insert(properties)
    .values({
      organizationId,
      reference: "VONI-AUH-999",
      title: "Tool integration sample",
      description: "Created and removed by verify-tools.mts.",
      location: "Yas Island, Abu Dhabi",
      price: 1_500_000,
      type: "apartment",
      bedrooms: 2,
      amenities: ["pool"],
      availability: schedule,
    })
    .returning({ id: properties.id }))[0].id;

  const phone: ResolvedToolContext = {
    kind: "call",
    callId,
    leadId,
    organizationId,
    telnyxCallControlId: "test-call-control-id",
  };
  const browser: ResolvedToolContext = { kind: "test", agentId, organizationId };
  assert.equal((await resolveCallContext(callId))?.organizationId, organizationId);
  assert.equal(await resolveCallContext(crypto.randomUUID()), null);
  const resolvedTest = await resolveTestContext(agentId, organizationId);
  assert.equal(resolvedTest?.kind, "test");
  assert.equal(resolvedTest?.kind === "test" && resolvedTest.agentId, agentId);
  assert.equal(await resolveTestContext(agentId, `${organizationId}-foreign`), null);

  const search = await executeTool(
    "search_properties",
    { location: "Yas", bedrooms: 2 },
    phone,
    "search-1",
  );
  assert.equal(search.ok, true);
  assert.equal(search.ok && search.data.count, 1);

  const foreign = await executeTool(
    "get_property_details",
    { reference: "VONI-AUH-999" },
    { ...browser, organizationId: `${organizationId}-foreign` },
    "foreign-1",
  );
  assert.equal(foreign.ok, false);

  const malformed = await executeTool(
    "book_viewing",
    { reference: "VONI-AUH-999", datetime: "tomorrow" },
    phone,
    "malformed-1",
  );
  assert.equal(malformed.ok, false);

  const concurrent = await Promise.all([
    executeTool(
      "book_viewing",
      { reference: "VONI-AUH-999", datetime: "2026-09-06T10:00:00+04:00" },
      phone,
      "booking-race-a",
    ),
    executeTool(
      "book_viewing",
      { reference: "VONI-AUH-999", datetime: "2026-09-06T10:00:00+04:00" },
      phone,
      "booking-race-b",
    ),
  ]);
  assert.equal(concurrent.filter((result) => result.ok).length, 1);

  const booked = await executeTool(
    "book_viewing",
    { reference: "VONI-AUH-999", datetime: "2026-09-06T11:00:00+04:00" },
    phone,
    "booking-idempotent",
  );
  const replay = await executeTool(
    "book_viewing",
    { reference: "VONI-AUH-999", datetime: "2026-09-06T11:00:00+04:00" },
    phone,
    "booking-idempotent",
  );
  assert.deepEqual(replay, booked);

  const before = {
    appointments: await db.$count(appointments, eq(appointments.leadId, leadId)),
    followUps: await db.$count(followUps, eq(followUps.leadId, leadId)),
    logs: await db.$count(toolCallLogs, eq(toolCallLogs.callId, callId)),
  };
  const dryBooking = await executeTool(
    "book_viewing",
    { reference: "VONI-AUH-999", datetime: "2026-09-06T12:00:00+04:00" },
    browser,
    "dry-booking",
  );
  const dryFollowUp = await executeTool(
    "schedule_follow_up",
    { datetime: "2026-09-07T10:00:00+04:00", channel: "phone" },
    browser,
    "dry-follow-up",
  );
  const dryLead = await executeTool(
    "update_lead",
    { budget: "AED 1.5M" },
    browser,
    "dry-lead",
  );
  assert.equal(dryBooking.ok && dryBooking.dryRun, true);
  assert.equal(dryFollowUp.ok && dryFollowUp.dryRun, true);
  assert.equal(dryLead.ok && dryLead.dryRun, true);
  assert.deepEqual(
    {
      appointments: await db.$count(appointments, eq(appointments.leadId, leadId)),
      followUps: await db.$count(followUps, eq(followUps.leadId, leadId)),
      logs: await db.$count(toolCallLogs, eq(toolCallLogs.callId, callId)),
    },
    before,
  );

  const missingTransfer = await executeTool(
    "transfer_to_human",
    { reason: "Caller requested a person" },
    phone,
    "missing-transfer-config",
  );
  assert.equal(missingTransfer.ok, false);
  assert.equal(!missingTransfer.ok && missingTransfer.retryable, true);

  const [{ value: activeBookings }] = await db
    .select({ value: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.propertyId, propertyId),
        eq(appointments.status, "confirmed"),
      ),
    );
  assert.equal(Number(activeBookings), 2);
  console.log(
    JSON.stringify({
      organizationIsolation: "passed",
      malformedArguments: "passed",
      concurrentBooking: "one winner",
      idempotentReplay: "reused stored result",
      browserDryRun: "no table changes",
      missingTransferConfiguration: "recoverable error",
    }),
  );
} finally {
  if (callId) await db.delete(toolCallLogs).where(eq(toolCallLogs.callId, callId));
  if (leadId) {
    await db.delete(appointments).where(eq(appointments.leadId, leadId));
    await db.delete(followUps).where(eq(followUps.leadId, leadId));
  }
  if (callId) await db.delete(calls).where(eq(calls.id, callId));
  if (propertyId) await db.delete(properties).where(eq(properties.id, propertyId));
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  if (leadId) await db.delete(leads).where(eq(leads.id, leadId));
}
