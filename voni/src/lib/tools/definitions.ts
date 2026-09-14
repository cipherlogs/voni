import { z } from "zod";
import type { AgentConfig, CustomTool } from "@/lib/agents/config";
import { TOOL_NAMES } from "@/lib/agents/config";
import { sensitiveCaptureFields } from "@/lib/agents/compile";

export const SENSITIVE_CAPTURE_TOOL = "prepare_sensitive_capture";

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .describe("An ISO 8601 date-time with an explicit UTC offset.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const propertyReference = z
  .string()
  .trim()
  .regex(/^VONI-(AUH|DXB)-\d{3}$/i)
  .transform((value) => value.toUpperCase());

export const toolArgumentSchemas = {
  search_properties: z
    .object({
      location: z.string().trim().min(1).optional(),
      property_type: z.enum(["apartment", "villa", "townhouse"]).optional(),
      min_price_aed: z.number().int().nonnegative().optional(),
      max_price_aed: z.number().int().nonnegative().optional(),
      bedrooms: z.number().int().min(0).max(20).optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.min_price_aed === undefined ||
        value.max_price_aed === undefined ||
        value.min_price_aed <= value.max_price_aed,
      { message: "Minimum price cannot exceed maximum price." },
    ),
  get_property_details: z.object({ reference: propertyReference }).strict(),
  check_availability: z
    .object({ reference: propertyReference, datetime: isoDateTime })
    .strict(),
  check_calendar: z
    .object({ date: isoDate, reference: propertyReference.optional() })
    .strict(),
  book_viewing: z
    .object({ reference: propertyReference, datetime: isoDateTime })
    .strict(),
  schedule_follow_up: z
    .object({
      datetime: isoDateTime,
      channel: z.enum(["phone", "whatsapp"]),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  update_lead: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      budget: z.string().trim().min(1).max(200).optional(),
      location: z.string().trim().min(1).max(200).optional(),
      property_type: z
        .enum(["apartment", "villa", "townhouse", "other"])
        .optional(),
      timeline: z.string().trim().min(1).max(200).optional(),
      financing: z.enum(["cash", "mortgage", "undecided", "other"]).optional(),
      buyer_type: z.enum(["end_user", "investor", "undecided"]).optional(),
      buying_intent: z.enum(["exploring", "interested", "ready"]).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: "Provide at least one lead field to update.",
    }),
  transfer_to_human: z
    .object({ reason: z.string().trim().min(3).max(500) })
    .strict(),
} satisfies Record<(typeof TOOL_NAMES)[number], z.ZodType>;

export type ToolName = keyof typeof toolArgumentSchemas;

export type VoiceTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execution_mode: "interactive" | "hold";
  timeout_seconds: number;
  response_instructions?: { success: string; error: string };
};

const ref = {
  type: "string",
  pattern: "^VONI-(AUH|DXB)-[0-9]{3}$",
  examples: ["VONI-AUH-001"],
  description: "The exact property reference returned by a property tool.",
};
const datetime = {
  type: "string",
  format: "date-time",
  examples: ["2026-09-06T10:00:00+04:00"],
  description: "ISO 8601 date and time with an explicit offset. Dubai is UTC+04:00.",
};

const BUSINESS_TOOLS: Record<ToolName, VoiceTool> = {
  search_properties: {
    type: "function",
    name: "search_properties",
    description:
      "Search the organization's property inventory. Call this before making any listing claim or when a caller describes what they want. Omit criteria the caller has not stated.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", examples: ["Yas Island"], description: "Area, island, or city." },
        property_type: { type: "string", enum: ["apartment", "villa", "townhouse"] },
        min_price_aed: { type: "integer", minimum: 0, examples: [1000000] },
        max_price_aed: { type: "integer", minimum: 0, examples: [2500000] },
        bedrooms: { type: "integer", minimum: 0, maximum: 20, examples: [2] },
      },
      additionalProperties: false,
    },
    execution_mode: "interactive",
    timeout_seconds: 10,
  },
  get_property_details: {
    type: "function",
    name: "get_property_details",
    description:
      "Get complete facts for one listing. Call this before answering detailed questions about a property returned by search_properties.",
    parameters: { type: "object", properties: { reference: ref }, required: ["reference"], additionalProperties: false },
    execution_mode: "interactive",
    timeout_seconds: 10,
  },
  check_availability: {
    type: "function",
    name: "check_availability",
    description:
      "Check whether one property is available for a one-hour viewing at an exact date and time. Call this before offering or booking that time.",
    parameters: { type: "object", properties: { reference: ref, datetime }, required: ["reference", "datetime"], additionalProperties: false },
    execution_mode: "interactive",
    timeout_seconds: 10,
  },
  check_calendar: {
    type: "function",
    name: "check_calendar",
    description:
      "Find open one-hour viewing slots on a date. Use a property reference when the caller has selected a listing.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", format: "date", examples: ["2026-09-06"] },
        reference: ref,
      },
      required: ["date"],
      additionalProperties: false,
    },
    execution_mode: "interactive",
    timeout_seconds: 10,
  },
  book_viewing: {
    type: "function",
    name: "book_viewing",
    description:
      "Book a confirmed one-hour viewing for the current lead. Call only after the caller has chosen both the property and exact time.",
    parameters: { type: "object", properties: { reference: ref, datetime }, required: ["reference", "datetime"], additionalProperties: false },
    execution_mode: "hold",
    timeout_seconds: 20,
    response_instructions: {
      success: "Confirm the property reference and viewing time in one short sentence.",
      error: "Say the booking did not complete, then offer an alternative from the result.",
    },
  },
  schedule_follow_up: {
    type: "function",
    name: "schedule_follow_up",
    description:
      "Schedule the next contact with the current lead. Call only after the caller agrees to the time and channel.",
    parameters: {
      type: "object",
      properties: {
        datetime,
        channel: { type: "string", enum: ["phone", "whatsapp"] },
        note: { type: "string", maxLength: 500, examples: ["Send the brochure first."] },
      },
      required: ["datetime", "channel"],
      additionalProperties: false,
    },
    execution_mode: "hold",
    timeout_seconds: 15,
  },
  update_lead: {
    type: "function",
    name: "update_lead",
    description:
      "Save qualification facts the caller explicitly provided. Send only fields learned or corrected in this conversation; omitted fields stay unchanged.",
    parameters: {
      type: "object",
      minProperties: 1,
      properties: {
        name: { type: "string", maxLength: 200 },
        budget: { type: "string", maxLength: 200, examples: ["AED 1.5M to 2M"] },
        location: { type: "string", maxLength: 200 },
        property_type: { type: "string", enum: ["apartment", "villa", "townhouse", "other"] },
        timeline: { type: "string", maxLength: 200 },
        financing: { type: "string", enum: ["cash", "mortgage", "undecided", "other"] },
        buyer_type: { type: "string", enum: ["end_user", "investor", "undecided"] },
        buying_intent: { type: "string", enum: ["exploring", "interested", "ready"] },
      },
      additionalProperties: false,
    },
    execution_mode: "hold",
    timeout_seconds: 15,
  },
  transfer_to_human: {
    type: "function",
    name: "transfer_to_human",
    description:
      "Transfer the live phone call to a human when the caller asks for one or the request requires human judgment. Explain the reason briefly.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", minLength: 3, maxLength: 500, examples: ["Caller wants to negotiate the offer."] } },
      required: ["reason"],
      additionalProperties: false,
    },
    execution_mode: "hold",
    timeout_seconds: 30,
  },
};

/**
 * Compile one user-added webhook tool into a voice-callable function tool.
 * Permissive object schema: the agent sends whatever JSON the webhook
 * expects, and validation passes anything object-shaped through.
 */
export function compileCustomTool(tool: CustomTool): VoiceTool {
  return {
    type: "function",
    name: `custom_${tool.id}`,
    description: `${tool.label}. ${tool.description}`,
    parameters: { type: "object", additionalProperties: true },
    execution_mode: tool.mode,
    timeout_seconds: tool.mode === "hold" ? 20 : 15,
  };
}

export function customToolId(name: string): string | null {
  return name.startsWith("custom_") && name.length > "custom_".length
    ? name.slice("custom_".length)
    : null;
}

export function compileVoiceTools(config: AgentConfig): VoiceTool[] {
  const selected = config.tools.flatMap((name) => {
    const tool = BUSINESS_TOOLS[name as ToolName];
    return tool ? [tool] : [];
  });
  for (const custom of config.customTools ?? []) {
    selected.push(compileCustomTool(custom));
  }
  const sensitive = sensitiveCaptureFields(config);
  if (sensitive.length > 0) {
    selected.push({
      type: "function",
      name: SENSITIVE_CAPTURE_TOOL,
      description:
        "Internal pacing control. Call this immediately before asking the caller for one of the listed sensitive fields. Never mention this tool to the caller.",
      parameters: {
        type: "object",
        properties: {
          field_key: {
            type: "string",
            enum: sensitive,
            examples: [sensitive[0]],
            description: "The sensitive field you are about to ask for.",
          },
        },
        required: ["field_key"],
        additionalProperties: false,
      },
      execution_mode: "hold",
      timeout_seconds: 5,
    });
  }
  return selected;
}

export function validateToolArguments(name: string, value: unknown) {
  // Custom webhook tools accept any object-shaped arguments — the webhook
  // owns its contract, and strictness here would reject valid payloads.
  if (customToolId(name) !== null) {
    return typeof value === "object" && value !== null
      ? { ok: true as const, data: value as Record<string, unknown> }
      : { ok: false as const, error: "Tool arguments must be an object." };
  }
  const schema = toolArgumentSchemas[name as ToolName];
  if (!schema) return { ok: false as const, error: "Unknown tool." };
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues[0]?.message ?? "Invalid tool arguments.",
    };
  }
  return { ok: true as const, data: parsed.data as Record<string, unknown> };
}

