import { z } from "zod";
import { findCatalogTool } from "@/lib/providers/registry";
import {
  CONVERSATION_LANGUAGES,
  MAX_AGENT_NAME_LENGTH,
  MAX_GOAL_LENGTH,
  MAX_GOALS,
  MAX_STYLE_LENGTH,
  MAX_STYLE_TRAITS,
  MAX_TASK_LENGTH,
  MAX_TASKS,
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
 *
 * It has no control on the agent detail page — that form follows a mockup with
 * no toggle for it — so it is authored by the wizard and the generator, and the
 * detail form must round-trip it untouched rather than dropping it on save.
 */
export const detectFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  sensitive: z.boolean().default(false),
});

/**
 * An LLM-suggested tool idea: work the wizard brief implies but no built-in
 * covers. Display-only — never executed, never compiled into voice tools.
 * Survives `normalizeConfig` verbatim so a generation's suggestions reach the
 * review screen and the detail form's "Suggested for this agent" group.
 */
export const toolIdeaSchema = z.object({
  name: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
});

/**
 * A user-added custom tool: a webhook the agent may call mid-conversation.
 * `kind` is `"webhook"` only (no code editor in this pass); `mode` follows
 * the built-in convention (`interactive` talks over the result, `hold`
 * stops and waits). `authCredentialName` names a platform credential whose
 * value is sent as a bearer header — free-form so any provider works.
 */
export const customToolSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  mode: z.enum(["interactive", "hold"]).default("interactive"),
  kind: z.literal("webhook").default("webhook"),
  url: z.string().trim().url().max(2000),
  authCredentialName: z.string().trim().min(1).max(80).optional(),
});

export const agentConfigSchema = z.object({
  /** One sentence: the business outcome this agent exists to produce. */
  mission: z.string().min(1),
  /** Who the agent says it is. Section (1q): an identity, not a behaviour list. */
  identity: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
  }),
  /** Qualification data to extract during the conversation. */
  detect: z.array(detectFieldSchema).default([]),
  /**
   * Tool names from TOOL_REGISTRY, plus connected-provider keys in
   * `"<provider>.<tool>"` form (see `findCatalogTool`). Unknown names in
   * either namespace are dropped on normalize.
   */
  tools: z.array(z.string()).default([]),
  /**
   * LLM-suggested tool ideas from the wizard brief. Optional with a default
   * so legacy configurations keep parsing; stored in existing JSON config
   * storage — no column migration.
   */
  toolIdeas: z.array(toolIdeaSchema).default([]),
  /**
   * User-added webhook tools. Validated by shape (not dropped) on normalize;
   * stored in existing JSON config storage — no column migration.
   */
  customTools: z.array(customToolSchema).default([]),
  /**
   * House rules: hard facts and prohibitions, as one free-text block.
   *
   * Stored configurations written before this became a single field hold a
   * `string[]`, and rows are not migrated — the preprocess folds a legacy
   * array back into one string on every parse path. Without it
   * `agentConfigSchema.safeParse` rejects every pre-existing agent, which
   * breaks saving and retrying deployment on all of them, not just editing.
   */
  knowledge: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            // These were list items, so most carry no terminal punctuation.
            // Joined raw they compile into one run-on sentence in the system
            // prompt, so give each its own full stop unless it already ends.
            .map((entry) => (/[.!?]$/.test(entry) ? entry : `${entry}.`))
            .join(" ")
        : value,
    z.string().default(""),
  ),
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
   * Owner-supplied vocabulary: jargon, product and place names the agent's
   * own config cannot see (drug names, menu items, transliterated business
   * names). Merged into STT keyterms by `buildAgentKeyterms`. Optional so
   * legacy configurations keep parsing; stored in existing JSON config
   * storage — no column migration.
   */
  keyterms: z
    .array(z.string().trim().min(1).max(60))
    .max(50)
    .optional(),
  /**
   * The first thing the caller hears. Kept as its own field because it is the
   * one utterance with no thinking latency in front of it (HANDOFF 1p measured
   * 382ms vs seconds for everything after), which is why callers consistently
   * rate the greeting as the best-sounding moment of the call.
   */
  greeting: z.string().min(1),
  /**
   * Wizard-authored goals (1–3 × ≤140), tasks (0–12 × ≤140) and conversational
   * style tags (0–5 × ≤60), plus the single conversation language. Optional so
   * legacy configurations keep parsing. Stored in existing JSON config
   * storage — no column migration.
   */
  goals: z
    .array(z.string().trim().min(1).max(MAX_GOAL_LENGTH))
    .min(1)
    .max(MAX_GOALS)
    .optional(),
  tasks: z
    .array(z.string().trim().min(1).max(MAX_TASK_LENGTH))
    .max(MAX_TASKS)
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
 * Drop tool names neither the built-in registry nor the connected-provider
 * catalog knows about.
 *
 * Small models cheerfully invent plausible tools (`send_brochure`,
 * `qualify_lead`). Registering one that has no server-side implementation would
 * make the agent call it mid-conversation and stall, so this filters rather
 * than trusting the model. Runs after schema validation, on every path.
 *
 * Namespaced provider keys (`"<provider>.<tool>"`, e.g. `gmail.send_email`)
 * survive when they resolve via `findCatalogTool`; anything else with a dot is
 * not a known provider tool and is dropped like any other invented name.
 *
 * Custom webhook tools and LLM tool ideas are kept verbatim: customs are
 * validated by shape (schema above), and ideas are display-only — neither can
 * stall a call the way an invented built-in name would.
 */
export function normalizeConfig(config: AgentConfig): AgentConfig {
  const known = new Set<string>(TOOL_NAMES);
  return {
    ...config,
    tools: config.tools.filter(
      (t) => known.has(t) || findCatalogTool(t) !== null,
    ),
    toolIdeas: [...(config.toolIdeas ?? [])],
    customTools: [...(config.customTools ?? [])],
  };
}

export type ToolIdea = z.infer<typeof toolIdeaSchema>;
export type CustomTool = z.infer<typeof customToolSchema>;

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
  identity: { name: "Voni", role: "property consultant" },
  detect: [
    { key: "budget", label: "Budget", description: "Price range the lead can commit to.", sensitive: true },
    { key: "location", label: "Location", description: "Preferred area or community.", sensitive: false },
    { key: "property_type", label: "Property type", description: "Apartment, villa, townhouse.", sensitive: false },
    { key: "timeline", label: "Timeline", description: "How soon they want to move or buy.", sensitive: false },
    { key: "financing", label: "Financing", description: "Cash, mortgage, or undecided.", sensitive: true },
    { key: "investment_or_end_user", label: "Investment or end user", description: "Buying to live in or to let.", sensitive: false },
    { key: "buying_intent", label: "Buying intent", description: "How serious and ready they are.", sensitive: false },
  ],
  tools: [...TOOL_NAMES],
  toolIdeas: [],
  customTools: [],
  // Vertical flavor lives HERE, in the template — never in platform
  // defaults. The keyterms builder only sees this list because this agent
  // carries it, like any owner-supplied list on any agent.
  keyterms: [
    "Layla",
    "Abu Dhabi",
    "Dubai",
    "Yas Island",
    "Saadiyat",
    "Dubai Marina",
    "JBR",
    "Downtown Dubai",
    "Business Bay",
    "Palm Jumeirah",
    "VONI-AUH",
    "VONI-DXB",
    "AED",
    "dirham",
    "mortgage",
    "viewing",
    "Bayut",
    "Property Finder",
  ],
  knowledge:
    "Never invent property information — every property fact must come from a tool result. Respect the campaign's calling-hours window. Never proceed without recorded consent. If asked whether this is a recording or an AI, say so plainly and continue.",
  channels: ["phone", "whatsapp"],
  voiceId: "anna",
  // Left empty: the UAE market is bilingual, and automatic detection
  // code-switches across all 18 recognised languages. Pinning ["en"] here
  // would make the agent worse at exactly the callers it is aimed at.
  languageCodes: [],
  greeting: "Hi, this is Voni. Can you hear me okay?",
};
