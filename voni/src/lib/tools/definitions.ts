import { z } from "zod";
import type { AgentConfig, CustomTool } from "@/lib/agents/config";
import { TOOL_NAMES } from "@/lib/agents/config";
import { sensitiveCaptureFields } from "@/lib/agents/compile";
import { findCatalogTool } from "@/lib/providers/registry";
import type { ToolResponse } from "./execute";

export const SENSITIVE_CAPTURE_TOOL = "prepare_sensitive_capture";

/**
 * Built-in call control. Every agent gets it — it is appended by
 * `compileVoiceTools`, never picked in the tool picker, so it stays out of
 * TOOL_REGISTRY/TOOL_NAMES (which drive the picker and the normalize
 * filter). Hold-mode: the agent speaks `closing_line`, then each path tears
 * down its own leg after the goodbye lands.
 */
export const END_CALL_TOOL = "end_call";

export const endCallSchema = z
  .object({
    closing_line: z.string().trim().min(1).max(300),
  })
  .strict();

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

/**
 * Stored-agent (REST) tool shape. The Agents API tool object is
 * `{name, description, parameters, http, timeout_seconds, execution_mode}` —
 * it has NO `type` field (`type: "function"` belongs only to the inline
 * `session.update` format). Sending `type` risks the tool being rejected or
 * dropped, which leaves the prompt talking about tools the model cannot
 * call — the model then improvises the call as speech
 * (`end_call{closing_line: ...}` out loud). Strip it at the boundary.
 */
export type RestTool = Omit<VoiceTool, "type">;

export function toRestTool(tool: VoiceTool): RestTool {
  const { type: _type, ...rest } = tool;
  void _type;
  return rest;
}

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

/** Built-in call control, exported for paths that compile tools piecemeal (demo agents). */
export const END_CALL_VOICE_TOOL: VoiceTool = {  type: "function",
  name: END_CALL_TOOL,
  description:
    "End the call when the task is complete, the caller asked to end, consent was denied, or the conversation loops with no progress — only after every other tool has returned and you have spoken a brief natural goodbye such as 'Okay, bye!'. Never announce the hang-up itself.",
  parameters: {
    type: "object",
    properties: {
      closing_line: {
        type: "string",
        maxLength: 300,
        examples: ["Thanks for your time — I'll send the details on WhatsApp. Goodbye!"],
        description: "The brief natural goodbye you just spoke to the caller. Just the goodbye.",
      },
    },
    required: ["closing_line"],
    additionalProperties: false,
  },
  execution_mode: "hold",
  timeout_seconds: 5,
  // The result auto-fires the next reply, and without guidance the model
  // fills that turn by narrating the hang-up ("the call has ended").
  // Humans just go silent — the sound and the screen say the rest — so the
  // success instruction orders silence in exactly that turn. The error
  // instruction covers the refusal path (another tool still running): stay
  // on the call and finish the pending task instead of hanging up.
  response_instructions: {
    success:
      "The goodbye was already spoken — do not say goodbye again. Say nothing further. Do not speak after this call — it is over.",
    error: "Stay on the call and finish the pending task first.",
  },
};

/**
 * end_call's success result: pure signal (`ended: true`) with NO speakable
 * text. The model reads tool results as things to say, so any confirmation
 * sentence here gets parroted as narration ("the call has ended"). The
 * goodbye itself is the `closing_line`, already spoken before the call —
 * the hang-up sound and the screen say the rest. Lives here, not in
 * execute.ts, so browser code (the voice session) can use it without
 * bundling the database.
 */
export function buildEndCallSuccess(dryRun: boolean): ToolResponse {
  return {
    ok: true,
    ...(dryRun ? { dryRun: true as const } : {}),
    hangup: true,
    data: { ended: true, ...(dryRun ? { simulated: true } : {}) },
  };
}

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

/**
 * Compile one connected-provider catalog tool into a voice-callable stub.
 *
 * The catalog carries no execution mode, so provider tools default to `hold`:
 * they are terminal side-effect actions (send an email, log a call), and hold
 * tells the agent to wait for a real result rather than narrate one it does
 * not have yet. Parameters stay permissive — provider tools have no
 * server-side argument schema yet, so execution fails closed in
 * `validateToolArguments` until a real implementation lands.
 */
export function compileProviderTool(key: string): VoiceTool | null {
  const hit = findCatalogTool(key);
  if (!hit) return null;
  return {
    type: "function",
    name: key,
    description: `${hit.provider.label} ${hit.tool.label}. ${hit.tool.description}`,
    parameters: { type: "object", additionalProperties: true },
    execution_mode: "hold",
    timeout_seconds: 20,
  };
}

export function compileVoiceTools(config: AgentConfig): VoiceTool[] {
  const selected = config.tools.flatMap((name) => {
    const tool = BUSINESS_TOOLS[name as ToolName];
    if (tool) return [tool];
    // Namespaced provider keys (`"<provider>.<tool>"`) compile to stubs so a
    // saved provider pick never breaks compilation of the built-ins it sits
    // beside; anything else unknown is still skipped silently.
    const providerTool = compileProviderTool(name);
    return providerTool ? [providerTool] : [];
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
  // Built-in call control, always last: every agent can end its own call.
  // Appended, never picked — the picker only offers TOOL_REGISTRY names.
  selected.push({ ...END_CALL_VOICE_TOOL });
  return selected;
}

export function validateToolArguments(name: string, value: unknown) {
  // Built-in call control lives outside the registry (never picked, always
  // compiled), so it validates against its own schema here.
  if (name === END_CALL_TOOL) {
    const parsed = endCallSchema.safeParse(value);
    if (!parsed.success) {
      return {
        ok: false as const,
        error: parsed.error.issues[0]?.message ?? "Invalid tool arguments.",
      };
    }
    return { ok: true as const, data: parsed.data as Record<string, unknown> };
  }
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

