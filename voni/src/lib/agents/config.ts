import { z } from "zod";
import {
  CONVERSATION_LANGUAGES,
  MAX_AGENT_NAME_LENGTH,
  MAX_OUTCOME_LENGTH,
  MAX_OUTCOMES,
  MAX_STYLE_LENGTH,
  MAX_STYLE_TRAITS,
} from "./wizard";

/**
 * The Agent config — the structured artifact the "agent compiler" produces.
 *
 * Plan Section D calls an Agent a "reusable worker config ... Versioned JSON",
 * and Section F specifies the fields a natural-language brief compiles into.
 * This file is that contract, in one place, so three consumers agree on it:
 * the generator (NL -> config), the editable form (config -> UI), and the
 * prompt compiler (config -> AssemblyAI system_prompt).
 *
 * Everything is deliberately flat strings and string arrays rather than nested
 * objects. Free-tier models are small and nested schemas are where they fail
 * first; a shallow shape is also what makes the shadcn edit form trivial.
 */

/**
 * The eight tools of the real estate launch template (plan Section G).
 *
 * `mode` follows Section H: `interactive` for fast lookups the agent can talk
 * over, `hold` for terminal actions where it should stop and wait for a real
 * result rather than narrate an outcome it doesn't have yet.
 */
export const TOOL_REGISTRY = [
  { name: "search_properties", mode: "interactive", description: "Find properties matching the lead's stated criteria." },
  { name: "get_property_details", mode: "interactive", description: "Fetch full details for one specific property." },
  { name: "check_availability", mode: "interactive", description: "Check whether a property can be viewed at a given time." },
  { name: "check_calendar", mode: "interactive", description: "Look up open viewing slots." },
  { name: "book_viewing", mode: "hold", description: "Book a confirmed property viewing for the lead." },
  { name: "schedule_follow_up", mode: "hold", description: "Schedule a later follow-up contact." },
  { name: "update_lead", mode: "hold", description: "Write qualification data back to the lead record." },
  { name: "transfer_to_human", mode: "hold", description: "Hand the live call to a human closer." },
] as const;

export const TOOL_NAMES = TOOL_REGISTRY.map((t) => t.name);

export const CHANNELS = ["phone", "whatsapp"] as const;

/**
 * A field the agent must capture during the conversation.
 *
 * ⚠️ `sensitive` is load-bearing, not decorative. HANDOFF (1t) records that we
 * set `min_silence: 100` / `max_silence: 500` to win back ~1s of latency, and
 * that this *disabled adaptive pacing and entity-aware waiting* — so the agent
 * will cut a caller off mid phone-number or mid-email. Both fields are mutable
 * mid-session, and this flag is what tells the bridge which capture steps need
 * them temporarily raised. Marking a field sensitive is how that gets wired.
 */
export const detectFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  sensitive: z.boolean().default(false),
});

export const agentConfigSchema = z.object({
  /** One sentence: the business outcome this agent exists to produce. */
  mission: z.string().min(1),
  /** Who the agent says it is. Section (1q): an identity, not a behaviour list. */
  identity: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    company: z.string().default(""),
  }),
  /** Qualification data to extract during the conversation. */
  detect: z.array(detectFieldSchema).default([]),
  /** Lead intents worth recognising and branching on. */
  intents: z.array(z.string()).default([]),
  /** Objections/blockers the agent should expect and handle. */
  blockers: z.array(z.string()).default([]),
  /** Tool names from TOOL_REGISTRY. Unknown names are dropped on normalize. */
  tools: z.array(z.string()).default([]),
  /** Hard facts and prohibitions. Section G: never invent property info. */
  knowledge: z.array(z.string()).default([]),
  successCondition: z.string().min(1),
  fallback: z.string().min(1),
  followUpPolicy: z.string().default(""),
  channels: z.array(z.enum(CHANNELS)).min(1).default(["phone"]),
  /** AssemblyAI voice catalog id. `anna` is the one validated on real calls. */
  voiceId: z.string().default("anna"),
  /**
   * `input.language_codes` — speech-recognition steering.
   *
   * EMPTY MEANS AUTOMATIC DETECTION ACROSS ALL 18 SUPPORTED LANGUAGES, which
   * the docs recommend for a mixed-language line. Pin codes only for a
   * region-specific line, where constraining the set stops the recogniser
   * drifting into look-alike transcriptions of another language.
   *
   * Note this is applied when the speech-to-text connection opens; changing it
   * mid-session takes effect on the next reconnect, not the current turn.
   */
  languageCodes: z.array(z.string()).default([]),
  /**
   * The first thing the caller hears. Kept as its own field because it is the
   * one utterance with no thinking latency in front of it (HANDOFF 1p measured
   * 382ms vs seconds for everything after), which is why callers consistently
   * rate the greeting as the best-sounding moment of the call.
   */
  greeting: z.string().min(1),
  /**
   * Wizard-authored outcomes (1–12 × ≤140) and conversational style tags
   * (0–5 × ≤60), plus the single conversation language. Optional so legacy
   * configurations keep parsing. Stored in existing JSON config storage —
   * no column migration.
   */
  outcomes: z
    .array(z.string().trim().min(1).max(MAX_OUTCOME_LENGTH))
    .min(1)
    .max(MAX_OUTCOMES)
    .optional(),
  styleTraits: z
    .array(z.string().trim().min(1).max(MAX_STYLE_LENGTH))
    .max(MAX_STYLE_TRAITS)
    .optional(),
  conversationLanguage: z.enum(CONVERSATION_LANGUAGES).optional(),
});

export const MAX_CONFIG_NAME_LENGTH = MAX_AGENT_NAME_LENGTH;

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type DetectField = z.infer<typeof detectFieldSchema>;

/**
 * Drop tool names the registry doesn't know about.
 *
 * Small models cheerfully invent plausible tools (`send_brochure`,
 * `qualify_lead`). Registering one that has no server-side implementation would
 * make the agent call it mid-conversation and stall, so this filters rather
 * than trusting the model. Runs after schema validation, on every path.
 */
export function normalizeConfig(config: AgentConfig): AgentConfig {
  const known = new Set<string>(TOOL_NAMES);
  return { ...config, tools: config.tools.filter((t) => known.has(t)) };
}

/**
 * The real estate launch template, verbatim from plan Section G.
 *
 * Plan Section T names this the mitigation for "NL-generated configs may need
 * heavy editing — ship the pre-built real estate template as the reliable
 * fallback." It is also what `/agents/new` offers when no LLM provider is
 * configured, so the page is never a dead end.
 */
export const REAL_ESTATE_TEMPLATE: AgentConfig = {
  mission:
    "Convert inbound and consented property leads into qualified viewing appointments.",
  identity: { name: "Voni", role: "property consultant", company: "" },
  detect: [
    { key: "budget", label: "Budget", description: "Price range the lead can commit to.", sensitive: true },
    { key: "location", label: "Location", description: "Preferred area or community.", sensitive: false },
    { key: "property_type", label: "Property type", description: "Apartment, villa, townhouse.", sensitive: false },
    { key: "timeline", label: "Timeline", description: "How soon they want to move or buy.", sensitive: false },
    { key: "financing", label: "Financing", description: "Cash, mortgage, or undecided.", sensitive: true },
    { key: "investment_or_end_user", label: "Investment or end user", description: "Buying to live in or to let.", sensitive: false },
    { key: "buying_intent", label: "Buying intent", description: "How serious and ready they are.", sensitive: false },
  ],
  intents: [
    "Wants to view a specific property",
    "Exploring the market, not ready yet",
    "Comparing areas or price points",
    "Wants to sell or let rather than buy",
    "Not interested / wrong number",
  ],
  blockers: [
    "Budget below anything available",
    "Wants an area we do not cover",
    "Needs to consult a partner before deciding",
    "Only wants to communicate over WhatsApp",
    "Asks a question only a human can answer",
  ],
  tools: [...TOOL_NAMES],
  knowledge: [
    "Never invent property information — every property fact must come from a tool result.",
    "Respect the campaign's calling-hours window.",
    "Never proceed without recorded consent.",
    "If asked whether this is a recording or an AI, say so plainly and continue.",
  ],
  successCondition: "A viewing is booked and confirmed.",
  fallback: "Schedule a follow-up, or transfer to a human closer if the lead asks.",
  followUpPolicy:
    "If no answer, retry once the next day within the calling window, then fall back to WhatsApp.",
  channels: ["phone", "whatsapp"],
  voiceId: "anna",
  // Left empty: the UAE market is bilingual, and automatic detection
  // code-switches across all 18 recognised languages. Pinning ["en"] here
  // would make the agent worse at exactly the callers it is aimed at.
  languageCodes: [],
  greeting: "Hi, this is Voni. Can you hear me okay?",
};
