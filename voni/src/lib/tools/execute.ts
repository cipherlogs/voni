import {
  and,
  asc,
  eq,
  gte,
  ilike,
  lte,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  appointments,
  calls,
  followUps,
  leads,
  properties,
  organizationSettings,
  toolCallLogs,
} from "@/lib/db/schema";
import { resolveCredential } from "@/lib/platform/credentials";
import { isCredentialName } from "@/lib/platform/types";
import {
  customToolId,
  validateToolArguments,
  type ToolName,
} from "./definitions";

export type ToolResponse =
  | { ok: true; data: Record<string, unknown>; dryRun?: boolean }
  | { ok: false; error: string; retryable: boolean };

export type ResolvedToolContext =
  | {
      kind: "call";
      callId: string;
      leadId: string;
      organizationId: string;
      telnyxCallControlId: string | null;
      /** Nullable: inbound bridge calls can exist before any stored agent row. */
      agentId: string | null;
    }
  | { kind: "test"; agentId: string; organizationId: string };

type WeeklyWindow = { start: string; end: string };
type Availability = {
  timezone: "Asia/Dubai";
  weekly: Record<string, WeeklyWindow[]>;
};

const DUBAI_OFFSET = "+04:00";
const ONE_HOUR = 60 * 60 * 1000;
const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function fail(error: string, retryable = false): ToolResponse {
  return { ok: false, error, retryable };
}

function propertyData(property: typeof properties.$inferSelect) {
  return {
    reference: property.reference,
    title: property.title,
    description: property.description,
    location: property.location,
    price: property.price,
    currency: property.currency,
    propertyType: property.type,
    bedrooms: property.bedrooms,
    amenities: property.amenities,
    viewingSchedule: property.availability,
  };
}

function dubaiParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dubai",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isWithinRecurringAvailability(
  value: Date,
  rawAvailability: unknown,
  durationMinutes = 60,
) {
  const availability = rawAvailability as Availability;
  if (availability?.timezone !== "Asia/Dubai" || !availability.weekly) {
    return false;
  }
  const parts = dubaiParts(value);
  const day = parts.weekday?.toLowerCase();
  const start = Number(parts.hour) * 60 + Number(parts.minute);
  return (availability.weekly[day] ?? []).some(
    (window) =>
      start >= minutes(window.start) &&
      start + durationMinutes <= minutes(window.end),
  );
}

function isOnDubaiHour(value: Date) {
  const parts = dubaiParts(value);
  return Number(parts.minute) === 0;
}

function dateAtDubaiHour(date: string, hour: number) {
  return new Date(
    `${date}T${hour.toString().padStart(2, "0")}:00:00${DUBAI_OFFSET}`,
  );
}

function iso(value: Date) {
  return value.toISOString();
}

async function findProperty(organizationId: string, reference: string) {
  const [property] = await db
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.organizationId, organizationId),
        eq(properties.reference, reference),
      ),
    )
    .limit(1);
  return property;
}

async function conflicts(propertyId: string, start: Date) {
  const rangeStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const rangeEnd = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      scheduledAt: appointments.scheduledAt,
      durationMinutes: appointments.durationMinutes,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.propertyId, propertyId),
        or(eq(appointments.status, "proposed"), eq(appointments.status, "confirmed")),
        gte(appointments.scheduledAt, rangeStart),
        lt(appointments.scheduledAt, rangeEnd),
      ),
    );
  const end = start.getTime() + ONE_HOUR;
  return rows.some((row) => {
    const existingStart = row.scheduledAt.getTime();
    const existingEnd = existingStart + row.durationMinutes * 60 * 1000;
    return start.getTime() < existingEnd && end > existingStart;
  });
}

async function openAlternatives(
  property: typeof properties.$inferSelect,
  around: Date,
  limit = 3,
) {
  const alternatives: string[] = [];
  for (let offset = 1; offset <= 14 * 24 && alternatives.length < limit; offset++) {
    const candidate = new Date(around.getTime() + offset * ONE_HOUR);
    if (!isOnDubaiHour(candidate)) continue;
    if (!isWithinRecurringAvailability(candidate, property.availability)) continue;
    if (!(await conflicts(property.id, candidate))) alternatives.push(iso(candidate));
  }
  return alternatives;
}

async function availabilityResult(
  organizationId: string,
  reference: string,
  datetimeValue: string,
) {
  const property = await findProperty(organizationId, reference);
  if (!property) return fail("Property not found.");
  const start = new Date(datetimeValue);
  const inSchedule =
    isOnDubaiHour(start) &&
    isWithinRecurringAvailability(start, property.availability);
  const occupied = inSchedule ? await conflicts(property.id, start) : false;
  const available = inSchedule && !occupied;
  return {
    property,
    response: {
      ok: true as const,
      data: {
        reference,
        datetime: iso(start),
        available,
        reason: available
          ? "available"
          : !inSchedule
            ? "outside viewing hours"
            : "already booked",
        alternatives: available ? [] : await openAlternatives(property, start),
      },
    },
  };
}

/**
 * Execute a user-added webhook tool. The agent's config is re-read from the
 * row (not trusted from the tool call) so a renamed or removed tool fails
 * closed. Test contexts dry-run like the built-in mutating tools.
 */
async function runCustomWebhookTool(
  id: string,
  args: Record<string, unknown>,
  context: ResolvedToolContext,
  externalCallId: string,
): Promise<ToolResponse> {
  // The agent's config is re-read from its row so a renamed or removed tool
  // fails closed. Test contexts carry the agent id directly; live calls
  // carry it on the call row (nullable — bridge inbound calls can predate
  // any stored agent row, in which case no custom tool can resolve).
  const agentId = context.kind === "call" ? context.agentId : context.agentId;
  if (!agentId) return fail("That custom tool is no longer configured.");
  const [row] = await db
    .select({ config: agents.config })
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.organizationId, context.organizationId),
      ),
    )
    .limit(1);
  const config = row?.config as
    | { customTools?: { id: string; url: string; authCredentialName?: string }[] }
    | undefined;
  const tool = config?.customTools?.find((t) => t.id === id);
  if (!tool) return fail("That custom tool is no longer configured.");
  if (context.kind === "test") {
    return {
      ok: true,
      dryRun: true,
      data: {
        simulated: true,
        confirmation: "Dry run only. The webhook was not called.",
        tool: tool.id,
        arguments: args,
      },
    };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (tool.authCredentialName && isCredentialName(tool.authCredentialName)) {
    const credential = await resolveCredential(tool.authCredentialName);
    if (credential.value) headers.Authorization = `Bearer ${credential.value}`;
  }
  let response: Response;
  try {
    response = await fetch(tool.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ arguments: args, externalCallId }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail("The custom tool is temporarily unavailable. Please try again.", true);
  }
  if (!response.ok) {
    return fail(
      "The custom tool rejected the request.",
      response.status >= 500,
    );
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A webhook that returns no JSON body still succeeded — report that.
  }
  return { ok: true, data: { tool: tool.id, ...data } };
}

async function runValidatedTool(
  name: ToolName,
  args: Record<string, unknown>,
  context: ResolvedToolContext,
  externalCallId: string,
): Promise<ToolResponse> {
  const organizationId = context.organizationId;

  const customId = customToolId(name);
  if (customId !== null) {
    return runCustomWebhookTool(customId, args, context, externalCallId);
  }

  switch (name) {
    case "search_properties": {
      const conditions: SQL[] = [eq(properties.organizationId, organizationId)];
      if (args.location) conditions.push(ilike(properties.location, `%${args.location}%`));
      if (args.property_type) conditions.push(eq(properties.type, String(args.property_type)));
      if (args.min_price_aed !== undefined) conditions.push(gte(properties.price, Number(args.min_price_aed)));
      if (args.max_price_aed !== undefined) conditions.push(lte(properties.price, Number(args.max_price_aed)));
      if (args.bedrooms !== undefined) conditions.push(eq(properties.bedrooms, Number(args.bedrooms)));
      const rows = await db
        .select()
        .from(properties)
        .where(and(...conditions))
        .orderBy(asc(properties.price), asc(properties.reference))
        .limit(5);
      return {
        ok: true,
        data: {
          count: rows.length,
          properties: rows.map((property) => ({
            reference: property.reference,
            title: property.title,
            location: property.location,
            price: property.price,
            currency: property.currency,
            propertyType: property.type,
            bedrooms: property.bedrooms,
          })),
        },
      };
    }
    case "get_property_details": {
      const property = await findProperty(organizationId, String(args.reference));
      if (!property) return fail("Property not found.");
      return { ok: true, data: propertyData(property) };
    }
    case "check_availability": {
      const checked = await availabilityResult(
        organizationId,
        String(args.reference),
        String(args.datetime),
      );
      return "response" in checked ? checked.response : checked;
    }
    case "check_calendar": {
      const date = String(args.date);
      const day = DAY_NAMES[dateAtDubaiHour(date, 12).getUTCDay()];
      if (day === "friday" || day === "saturday") {
        return { ok: true, data: { date, timezone: "Asia/Dubai", slots: [] } };
      }
      const rows = args.reference
        ? [await findProperty(organizationId, String(args.reference))].filter(Boolean)
        : await db
            .select()
            .from(properties)
            .where(eq(properties.organizationId, organizationId))
            .orderBy(asc(properties.reference));
      if (args.reference && rows.length === 0) return fail("Property not found.");
      const slots: { reference: string; datetime: string }[] = [];
      for (const property of rows) {
        if (!property) continue;
        for (let hour = 10; hour < 18 && slots.length < 5; hour++) {
          const candidate = dateAtDubaiHour(date, hour);
          if (
            isWithinRecurringAvailability(candidate, property.availability) &&
            !(await conflicts(property.id, candidate))
          ) {
            slots.push({ reference: property.reference, datetime: iso(candidate) });
          }
        }
        if (slots.length === 5) break;
      }
      return { ok: true, data: { date, timezone: "Asia/Dubai", slots } };
    }
    case "book_viewing": {
      const checked = await availabilityResult(
        organizationId,
        String(args.reference),
        String(args.datetime),
      );
      if (!("response" in checked)) return checked;
      if (!checked.response.data.available) {
        return fail(
          `That slot is not available. Alternatives: ${(
            checked.response.data.alternatives as string[]
          ).join(", ") || "none found"}.`,
        );
      }
      if (context.kind === "test") {
        return {
          ok: true,
          dryRun: true,
          data: {
            simulated: true,
            confirmation: "Dry run only. No appointment was created.",
            reference: checked.property.reference,
            datetime: iso(new Date(String(args.datetime))),
            durationMinutes: 60,
          },
        };
      }
      try {
        const [appointment] = await db
          .insert(appointments)
          .values({
            leadId: context.leadId,
            propertyId: checked.property.id,
            scheduledAt: new Date(String(args.datetime)),
            durationMinutes: 60,
            status: "confirmed",
          })
          .returning({ id: appointments.id });
        return {
          ok: true,
          data: {
            confirmationId: appointment.id,
            reference: checked.property.reference,
            datetime: iso(new Date(String(args.datetime))),
            durationMinutes: 60,
            status: "confirmed",
          },
        };
      } catch {
        const alternatives = await openAlternatives(
          checked.property,
          new Date(String(args.datetime)),
        );
        return fail(
          `That slot was just taken. Alternatives: ${alternatives.join(", ") || "none found"}.`,
        );
      }
    }
    case "schedule_follow_up": {
      if (context.kind === "test") {
        return {
          ok: true,
          dryRun: true,
          data: {
            simulated: true,
            confirmation: "Dry run only. No follow-up was scheduled.",
            ...args,
          },
        };
      }
      const [followUp] = await db
        .insert(followUps)
        .values({
          leadId: context.leadId,
          scheduledAt: new Date(String(args.datetime)),
          channel: String(args.channel),
          note: args.note ? String(args.note) : null,
        })
        .returning({ id: followUps.id });
      return {
        ok: true,
        data: { followUpId: followUp.id, status: "scheduled", ...args },
      };
    }
    case "update_lead": {
      if (context.kind === "test") {
        return {
          ok: true,
          dryRun: true,
          data: {
            simulated: true,
            confirmation: "Dry run only. The lead was not changed.",
            fields: args,
          },
        };
      }
      const [current] = await db
        .select({ preferences: leads.propertyPreferences })
        .from(leads)
        .where(eq(leads.id, context.leadId))
        .limit(1);
      const { name: leadName, ...qualification } = args;
      const existing =
        current?.preferences && typeof current.preferences === "object"
          ? (current.preferences as Record<string, unknown>)
          : {};
      await db
        .update(leads)
        .set({
          ...(leadName ? { name: String(leadName) } : {}),
          propertyPreferences: { ...existing, ...qualification },
          updatedAt: new Date(),
        })
        .where(eq(leads.id, context.leadId));
      return { ok: true, data: { updated: Object.keys(args) } };
    }
    case "transfer_to_human": {
      if (context.kind === "test") {
        return {
          ok: true,
          dryRun: true,
          data: {
            simulated: true,
            confirmation: "Simulated transfer. No phone call was changed.",
            reason: args.reason,
          },
        };
      }
      const [workspaceSettings] = await db
        .select({ humanTransferNumber: organizationSettings.humanTransferNumber })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, context.organizationId))
        .limit(1);
      const telnyxApiKey = (await resolveCredential("telnyx_api_key")).value;
      if (!workspaceSettings?.humanTransferNumber || !telnyxApiKey) {
        return fail("Human transfer is not configured. I can schedule a follow-up instead.", true);
      }
      if (!context.telnyxCallControlId) {
        return fail("The live phone leg is no longer available for transfer.", true);
      }
      const response = await fetch(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(context.telnyxCallControlId)}/actions/transfer`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${telnyxApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: workspaceSettings.humanTransferNumber,
            // Telnyx deduplicates retried transfer commands by command_id.
            // Reuse AssemblyAI's tool call id so both systems share one key.
            command_id: externalCallId,
          }),
        },
      );
      if (!response.ok) {
        return fail("The transfer was rejected. I can schedule a follow-up instead.", response.status >= 500);
      }
      return {
        ok: true,
        data: {
          transferStarted: true,
          confirmation: "The transfer request was accepted by the phone provider.",
          destination: "configured human line",
        },
      };
    }
  }
}

export async function executeTool(
  name: string,
  rawArguments: unknown,
  context: ResolvedToolContext,
  externalCallId: string,
): Promise<ToolResponse> {
  let ownsAttempt = context.kind === "test";
  if (context.kind === "call") {
    const inserted = await db
      .insert(toolCallLogs)
      .values({
        callId: context.callId,
        externalCallId,
        toolName: name,
        arguments:
          rawArguments && typeof rawArguments === "object" ? rawArguments : {},
      })
      .onConflictDoNothing()
      .returning({ id: toolCallLogs.id });
    ownsAttempt = inserted.length > 0;
    if (!ownsAttempt) {
      const [previous] = await db
        .select({ result: toolCallLogs.result })
        .from(toolCallLogs)
        .where(
          and(
            eq(toolCallLogs.callId, context.callId),
            eq(toolCallLogs.externalCallId, externalCallId),
          ),
        )
        .limit(1);
      if (previous?.result) return previous.result as ToolResponse;
      return fail("This tool call is still running. Please try again.", true);
    }
  }

  const started = performance.now();
  const parsed = validateToolArguments(name, rawArguments);
  let result: ToolResponse;
  if (!parsed.ok) {
    result = fail(parsed.error);
  } else {
    try {
      result = await runValidatedTool(
        name as ToolName,
        parsed.data,
        context,
        externalCallId,
      );
    } catch (error) {
      console.error(`[tool:${name}] execution failed`, error);
      result = fail("The tool is temporarily unavailable. Please try again.", true);
    }
  }

  if (context.kind === "call" && ownsAttempt) {
    await db
      .update(toolCallLogs)
      .set({
        result,
        isError: !result.ok,
        latencyMs: Math.round(performance.now() - started),
      })
      .where(
        and(
          eq(toolCallLogs.callId, context.callId),
          eq(toolCallLogs.externalCallId, externalCallId),
        ),
      );
  }
  return result;
}

export async function resolveCallContext(callId: string) {
  const [row] = await db
    .select({
      callId: calls.id,
      leadId: calls.leadId,
      organizationId: leads.organizationId,
      telnyxCallControlId: calls.telnyxCallControlId,
      agentId: calls.agentId,
    })
    .from(calls)
    .innerJoin(leads, eq(calls.leadId, leads.id))
    .where(eq(calls.id, callId))
    .limit(1);
  return row
    ? ({ kind: "call", ...row } satisfies ResolvedToolContext)
    : null;
}

export async function resolveTestContext(
  agentId: string,
  organizationId: string,
): Promise<ResolvedToolContext | null> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)),
    )
    .limit(1);
  return agent
    ? { kind: "test", agentId: agent.id, organizationId }
    : null;
}
