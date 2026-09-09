import { z } from "zod";
import { getVoice, VOICES } from "./voices";

/**
 * Shared wizard contract for the three-step /agents/new flow.
 *
 * Server-safe: no React, no client hooks. The client wizard state, voice
 * copilot tools, and generation job all validate through this one module so
 * voice can never create values the UI cannot represent.
 */

export const CONVERSATION_LANGUAGES = ["en", "es", "fr", "de", "it", "pt"] as const;

export type ConversationLanguage = (typeof CONVERSATION_LANGUAGES)[number];

export const conversationLanguageSchema = z.enum(CONVERSATION_LANGUAGES);

export const MAX_OUTCOMES = 12;
export const MAX_OUTCOME_LENGTH = 140;
export const MAX_STYLE_TRAITS = 5;
export const MAX_STYLE_LENGTH = 60;
export const MAX_AGENT_NAME_LENGTH = 120;

export const DEFAULT_CONVERSATION_LANGUAGE: ConversationLanguage = "en";
export const DEFAULT_WIZARD_VOICE_ID = "anna";

/** Trim ends and collapse internal whitespace runs to a single space. */
export function normalizeTag(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function caseInsensitiveDupes(values: string[]): boolean {
  const seen = new Set<string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

const outcomeItem = z
  .string()
  .trim()
  .min(1, "Add at least one outcome.")
  .max(MAX_OUTCOME_LENGTH, `Keep outcomes under ${MAX_OUTCOME_LENGTH} characters.`);

const styleItem = z
  .string()
  .trim()
  .min(1)
  .max(MAX_STYLE_LENGTH, `Keep style tags under ${MAX_STYLE_LENGTH} characters.`);

export const wizardDraftSchema = z
  .object({
    outcomes: z.array(outcomeItem).min(1).max(MAX_OUTCOMES),
    agentName: z
      .string()
      .trim()
      .min(1, "Give the agent a name.")
      .max(MAX_AGENT_NAME_LENGTH, `Keep names under ${MAX_AGENT_NAME_LENGTH} characters.`),
    styleTraits: z.array(styleItem).max(MAX_STYLE_TRAITS).default([]),
    conversationLanguage: conversationLanguageSchema,
    voiceId: z.string().trim().min(1, "Pick a voice."),
  })
  .superRefine((draft, ctx) => {
    if (caseInsensitiveDupes(draft.outcomes.map(normalizeTag))) {
      ctx.addIssue({ code: "custom", message: "That outcome is already added." });
    }
    if (caseInsensitiveDupes(draft.styleTraits.map(normalizeTag))) {
      ctx.addIssue({ code: "custom", message: "That style is already added." });
    }
    const voice = getVoice(draft.voiceId);
    if (!voice) {
      ctx.addIssue({ code: "custom", message: "Pick a voice from the list." });
      return;
    }
    if (voice.languageCode !== draft.conversationLanguage) {
      ctx.addIssue({
        code: "custom",
        message: "That voice does not speak the selected language.",
      });
    }
  });

export type WizardDraft = z.infer<typeof wizardDraftSchema>;

export const EMPTY_WIZARD_DRAFT: WizardDraft = {
  outcomes: [],
  agentName: "",
  styleTraits: [],
  conversationLanguage: DEFAULT_CONVERSATION_LANGUAGE,
  voiceId: DEFAULT_WIZARD_VOICE_ID,
};

/**
 * Normalize raw input the same way validation sees it: trim + collapse
 * whitespace, drop empties. Never splits on commas or punctuation.
 */
export function normalizeWizardDraft(raw: {
  outcomes: string[];
  agentName: string;
  styleTraits: string[];
  conversationLanguage: ConversationLanguage;
  voiceId: string;
}): WizardDraft {
  return {
    outcomes: raw.outcomes.map(normalizeTag).filter(Boolean),
    agentName: raw.agentName.trim(),
    styleTraits: raw.styleTraits.map(normalizeTag).filter(Boolean),
    conversationLanguage: raw.conversationLanguage,
    voiceId: raw.voiceId.trim(),
  };
}

export function validateWizardDraft(value: unknown): z.ZodSafeParseResult<WizardDraft> {
  return wizardDraftSchema.safeParse(value);
}

/**
 * Atomic language+voice resolution: keep the current voice when it already
 * speaks the new language; otherwise anna for English or the first matching
 * catalog entry.
 */
export function voiceForLanguage(
  language: ConversationLanguage,
  preferredVoiceId?: string,
): { voiceId: string; changed: boolean } {
  const preferred = preferredVoiceId ? getVoice(preferredVoiceId.trim()) : undefined;
  if (preferred && preferred.languageCode === language) {
    return { voiceId: preferred.id, changed: false };
  }
  if (language === "en") {
    return { voiceId: DEFAULT_WIZARD_VOICE_ID, changed: preferredVoiceId !== DEFAULT_WIZARD_VOICE_ID };
  }
  const first = VOICES.find((v) => v.languageCode === language);
  return { voiceId: first?.id ?? DEFAULT_WIZARD_VOICE_ID, changed: true };
}

/**
 * Short localized default greetings (fallback + template use). Always
 * editable in the UI; kept under 12 words and ending with a question.
 */
export const LOCALIZED_GREETINGS: Record<ConversationLanguage, string> = {
  en: "Hi, this is {name}. Can you hear me okay?",
  es: "Hola, soy {name}. ¿Me escuchas bien?",
  fr: "Bonjour, c'est {name}. Vous m'entendez bien ?",
  de: "Hallo, hier ist {name}. Hörst du mich gut?",
  it: "Ciao, sono {name}. Mi senti bene?",
  pt: "Olá, aqui é {name}. Está me ouvindo bem?",
};

export function defaultGreeting(language: ConversationLanguage, name: string): string {
  const safe = name.trim() || "Voni";
  return (LOCALIZED_GREETINGS[language] ?? LOCALIZED_GREETINGS.en).replace("{name}", safe);
}
