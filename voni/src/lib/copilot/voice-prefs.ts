/**
 * Per-user voice copilot preferences: who talks back, and in what language.
 *
 * Two deliberate constraints:
 * - The voice list is the documented catalog (VOICE_IDS) plus "ivy", the
 *   copilot's long-standing default, which predates the catalog file. Unknown
 *   ids are rejected — a typo must fail in Settings, not mid-call.
 * - `language: "auto"` omits `language_codes` entirely (docs: omit for
 *   automatic detection across all recognised languages). Any other value
 *   pins exactly one code. The copilot never pins a list: one voice speaks
 *   one language, so a list would only invite mismatches.
 */

import { z } from "zod";
import {
  INPUT_LANGUAGE_CODES,
  VOICE_IDS,
  getVoice,
  inputLanguage,
  voiceLabel,
} from "@/lib/agents/voices";

/** The copilot's default voice. Predates the catalog; kept working. */
export const DEFAULT_COPILOT_VOICE = "ivy";

/** Default language pin. Matches the copilot's historical behaviour. */
export const DEFAULT_COPILOT_LANGUAGE = "en";

const KNOWN_VOICES = [...VOICE_IDS, DEFAULT_COPILOT_VOICE];

export const copilotVoicePrefsSchema = z.object({
  voiceId: z
    .string()
    .trim()
    .refine((id) => (KNOWN_VOICES as readonly string[]).includes(id), {
      message: "Pick a voice from the list.",
    }),
  language: z
    .string()
    .trim()
    .refine(
      (code) =>
        code === "auto" || (INPUT_LANGUAGE_CODES as readonly string[]).includes(code),
      { message: "Pick a language from the list." },
    ),
});

export type CopilotVoicePrefs = z.infer<typeof copilotVoicePrefsSchema>;

export const DEFAULT_COPILOT_VOICE_PREFS: CopilotVoicePrefs = {
  voiceId: DEFAULT_COPILOT_VOICE,
  language: DEFAULT_COPILOT_LANGUAGE,
};

/** Merge a stored row (possibly partial/stale) over the defaults. */
export function coerceCopilotVoicePrefs(
  stored: Partial<CopilotVoicePrefs> | null | undefined,
): CopilotVoicePrefs {
  const parsed = copilotVoicePrefsSchema.safeParse({ ...DEFAULT_COPILOT_VOICE_PREFS, ...stored });
  return parsed.success ? parsed.data : { ...DEFAULT_COPILOT_VOICE_PREFS };
}

/**
 * `language_codes` for `session.update`, or null to omit the key (auto).
 * A voice pinned to a language it doesn't speak still hears everything —
 * recognition covers 18 languages — but answers in its own. Say that in the
 * UI, or "Arabic + Alba" reads as broken when it is a supported pattern.
 */
export function prefsLanguageCodes(prefs: CopilotVoicePrefs): string[] | null {
  if (prefs.language === "auto") return null;
  return [prefs.language];
}

/** Human line for a voice+language pairing, including the mismatch note. */
export function prefsPairingNote(prefs: CopilotVoicePrefs): string | null {
  const voice = getVoice(prefs.voiceId);
  if (!voice || prefs.language === "auto") return null;
  if (voice.languageCode === prefs.language) return null;
  const heard = inputLanguage(prefs.language)?.label ?? prefs.language;
  return `Note: ${voiceLabel(prefs.voiceId)} speaks ${voice.language}, so it will understand ${heard} but answer in ${voice.language}.`;
}
