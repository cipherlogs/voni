/**
 * The AssemblyAI Voice Agent language and voice catalog.
 *
 * Transcribed from the docs MCP (`/voice-agents/voice-agent-api/voices`,
 * `/supported-languages`, `/language-selection`), not from memory — the voice
 * catalog is closed and the docs are the only source of truth for which
 * `voice_id` and `language_codes` values are accepted.
 *
 * ── The asymmetry that shapes this whole file ──────────────────────────────
 * The agent UNDERSTANDS 18 languages but SPEAKS only 6. Arabic, Hindi,
 * Japanese, Mandarin, Turkish, Dutch, the Nordics, Vietnamese and Hebrew are
 * recognised with native code-switching, but have no voice yet ("coming soon"
 * per the docs). That is not a limitation to paper over in the UI: it directly
 * shapes the UAE launch market, where a caller may well speak Arabic and the
 * agent can only answer in English. The docs call this out as a legitimate
 * pattern — "the agent recognizes more languages than it speaks, this enables
 * translation use cases where a caller speaks one language and the agent
 * responds in another" — so we surface it as a real, supported configuration
 * rather than hiding the unspoken languages.
 */

/** Every language the speech-to-text side recognises. `code` goes in `language_codes`. */
export type InputLanguage = {
  code: string;
  label: string;
  flag: string;
  /** Whether a voice exists to reply in this language. */
  canSpeak: boolean;
};

export const INPUT_LANGUAGES: InputLanguage[] = [
  { code: "en", label: "English", flag: "🇺🇸", canSpeak: true },
  { code: "es", label: "Spanish", flag: "🇪🇸", canSpeak: true },
  { code: "fr", label: "French", flag: "🇫🇷", canSpeak: true },
  { code: "de", label: "German", flag: "🇩🇪", canSpeak: true },
  { code: "it", label: "Italian", flag: "🇮🇹", canSpeak: true },
  { code: "pt", label: "Portuguese", flag: "🇵🇹", canSpeak: true },
  // Recognised only — no voice yet. Listed in the docs' "coming soon" table.
  { code: "ar", label: "Arabic", flag: "🇸🇦", canSpeak: false },
  { code: "tr", label: "Turkish", flag: "🇹🇷", canSpeak: false },
  { code: "nl", label: "Dutch", flag: "🇳🇱", canSpeak: false },
  { code: "sv", label: "Swedish", flag: "🇸🇪", canSpeak: false },
  { code: "no", label: "Norwegian", flag: "🇳🇴", canSpeak: false },
  { code: "da", label: "Danish", flag: "🇩🇰", canSpeak: false },
  { code: "fi", label: "Finnish", flag: "🇫🇮", canSpeak: false },
  { code: "hi", label: "Hindi", flag: "🇮🇳", canSpeak: false },
  { code: "vi", label: "Vietnamese", flag: "🇻🇳", canSpeak: false },
  { code: "he", label: "Hebrew", flag: "🇮🇱", canSpeak: false },
  { code: "ja", label: "Japanese", flag: "🇯🇵", canSpeak: false },
  { code: "zh", label: "Mandarin", flag: "🇨🇳", canSpeak: false },
];

export const INPUT_LANGUAGE_CODES = INPUT_LANGUAGES.map((l) => l.code);

export function inputLanguage(code: string): InputLanguage | undefined {
  return INPUT_LANGUAGES.find((l) => l.code === code);
}

export type VoicePresents = "feminine" | "masculine" | "unspecified";

export type Voice = {
  id: string;
  /** Documented. */
  accent: "US" | "UK" | "IT" | "ES" | "DE" | "PT" | "FR";
  /**
   * Inferred from the voice name — the docs publish accent ONLY, never gender.
   * Kept in a separately named field so nobody mistakes it for documented fact.
   * Correcting one of these after actually listening is expected maintenance,
   * not a bug report.
   */
  presents: VoicePresents;
  /** Output language this voice speaks natively. Documented. */
  language: string;
  /** `language_codes` value that pairs with this voice. */
  languageCode: string;
};

export const VOICES: Voice[] = [
  // English — 🇺🇸 American
  { id: "alba", accent: "US", presents: "feminine", language: "English", languageCode: "en" },
  { id: "eve", accent: "US", presents: "feminine", language: "English", languageCode: "en" },
  { id: "jane", accent: "US", presents: "feminine", language: "English", languageCode: "en" },
  { id: "mary", accent: "US", presents: "feminine", language: "English", languageCode: "en" },
  { id: "george", accent: "US", presents: "masculine", language: "English", languageCode: "en" },
  { id: "michael", accent: "US", presents: "masculine", language: "English", languageCode: "en" },
  // "jean" reads as either Jean or Gene in English and the docs don't say.
  { id: "jean", accent: "US", presents: "unspecified", language: "English", languageCode: "en" },
  // English — 🇬🇧 British
  { id: "anna", accent: "UK", presents: "feminine", language: "English", languageCode: "en" },
  { id: "vera", accent: "UK", presents: "feminine", language: "English", languageCode: "en" },
  { id: "charles", accent: "UK", presents: "masculine", language: "English", languageCode: "en" },
  { id: "paul", accent: "UK", presents: "masculine", language: "English", languageCode: "en" },
  // Native-accent voices for the other five output languages. These
  // code-switch naturally between their language and English.
  { id: "giovanni", accent: "IT", presents: "masculine", language: "Italian", languageCode: "it" },
  { id: "lola", accent: "ES", presents: "feminine", language: "Spanish", languageCode: "es" },
  { id: "juergen", accent: "DE", presents: "masculine", language: "German", languageCode: "de" },
  { id: "rafael", accent: "PT", presents: "masculine", language: "Portuguese", languageCode: "pt" },
  { id: "estelle", accent: "FR", presents: "feminine", language: "French", languageCode: "fr" },
];

export const VOICE_IDS = VOICES.map((v) => v.id);

export const ACCENT_LABEL: Record<Voice["accent"], string> = {
  US: "American",
  UK: "British",
  IT: "Italian",
  ES: "Spanish",
  DE: "German",
  PT: "Portuguese",
  FR: "French",
};

/** Flag per accent, shown next to the accent label on voice cards. Emoji
    only — no assets, no sizing classes (same convention as the language chips
    above, which render `lang.flag` bare inside the toggle). */
export const ACCENT_FLAG: Record<Voice["accent"], string> = {
  US: "🇺🇸",
  UK: "🇬🇧",
  IT: "🇮🇹",
  ES: "🇪🇸",
  DE: "🇩🇪",
  PT: "🇵🇹",
  FR: "🇫🇷",
};

/** Voices grouped by the language they speak, for a grouped picker. */
export function voicesByLanguage(): { language: string; code: string; voices: Voice[] }[] {
  const order = ["English", "Spanish", "French", "German", "Italian", "Portuguese"];
  return order
    .map((language) => {
      const voices = VOICES.filter((v) => v.language === language);
      return { language, code: voices[0]?.languageCode ?? "en", voices };
    })
    .filter((group) => group.voices.length > 0);
}

export function getVoice(id: string): Voice | undefined {
  return VOICES.find((v) => v.id === id);
}

/** Title-case a voice id for display. The ids are first names. */
export function voiceLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * The languages this agent will actually understand, given its config.
 *
 * An empty `language_codes` means automatic detection across all 18, which the
 * docs recommend for a mixed-language line — so "unset" is *more* capable than
 * a pinned list, not less. The UI has to say that, or an empty selector reads
 * as "no languages".
 */
export function understoodLanguages(codes: string[]): InputLanguage[] {
  if (codes.length === 0) return INPUT_LANGUAGES;
  return INPUT_LANGUAGES.filter((l) => codes.includes(l.code));
}
