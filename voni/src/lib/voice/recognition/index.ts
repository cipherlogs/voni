import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";
import { EN_RECOGNITION } from "./en";
import { LOCALE_RECOGNITION } from "./locales";
import {
  RECOGNITION_SLOTS,
  type CompleteRecognition,
  type RecognitionBundle,
  type RecognitionLocale,
  type RecognitionResolution,
  type RecognitionSlots,
  type RecognitionSlotValues,
  type RecognitionSlotName,
} from "./types";

export * from "./types";
export * from "./match";
export * from "./completeness";
export { EN_RECOGNITION } from "./en";
export { LOCALE_RECOGNITION } from "./locales";

/**
 * The registry of recognition renderings, keyed by the Locale a call is
 * conducted in. One entry per spoken Locale; a Locale that is not here is a
 * hole and is reported as one.
 *
 * English is the first rendering, not the fallback: nothing in this module
 * ever reaches for `en` because another key is absent.
 */
const REGISTRY: Partial<Record<RecognitionLocale, RecognitionBundle>> = {
  en: { locale: "en", slots: EN_RECOGNITION },
  ...Object.fromEntries(
    (Object.keys(LOCALE_RECOGNITION) as (keyof typeof LOCALE_RECOGNITION)[]).map((locale) => [
      locale,
      { locale, slots: LOCALE_RECOGNITION[locale] },
    ]),
  ),
};

/** Whether `value` is a spoken Locale recognition can be keyed by. */
export function isRecognitionLocale(value: string): value is RecognitionLocale {
  return (CONVERSATION_LANGUAGES as readonly string[]).includes(value);
}

/** What a call says about the Locale it is conducted in. */
export type CallLanguageSource = {
  /** The single conversation language chosen for the agent, if any. */
  readonly conversationLanguage?: string | null;
  /** The pinned recognition codes. Empty means automatic detection. */
  readonly languageCodes?: readonly string[] | null;
};

/**
 * The Locale a call's recognition is keyed by, or `null` for automatic
 * detection.
 *
 * The conversation language wins when it names a spoken Locale. Otherwise the
 * first pinned code recognition knows decides — the demo picks a voice, and the
 * voice pins the code. A call with nothing pinned is automatic detection, the
 * one documented exception where English scaffolding is used.
 */
export function callRecognitionLocale(source: CallLanguageSource): RecognitionLocale | null {
  const conversation = source.conversationLanguage;
  if (conversation && isRecognitionLocale(conversation)) return conversation;
  for (const code of source.languageCodes ?? []) {
    if (isRecognitionLocale(code)) return code;
  }
  return null;
}

/**
 * The vocabulary a Locale is primed with, or `undefined` when the Locale has
 * no vocabulary rendering yet. A hole stays a hole; an absent Locale never
 * resolves to English's words.
 */
export function recognitionVocabulary(locale: string): readonly string[] | undefined {
  return isRecognitionLocale(locale) ? REGISTRY[locale]?.slots.vocabulary : undefined;
}

/** The slots a rendering is still missing, in report order. */
export function missingSlots(slots: RecognitionSlots): RecognitionSlotName[] {
  return RECOGNITION_SLOTS.filter((name) => slots[name] === undefined);
}

function isCompleteSlots(slots: RecognitionSlots): slots is RecognitionSlotValues {
  return RECOGNITION_SLOTS.every((name) => slots[name] !== undefined);
}

/**
 * A bundle with every slot present is `complete`; one with holes is
 * `incomplete` and names them. No branch reaches for another Locale's words,
 * so an incomplete rendering can never be mistaken for a working one.
 */
export function resolveBundle(bundle: RecognitionBundle): RecognitionResolution {
  if (!isCompleteSlots(bundle.slots)) {
    return { status: "incomplete", locale: bundle.locale, missing: missingSlots(bundle.slots) };
  }
  return { status: "complete", recognition: { locale: bundle.locale, ...bundle.slots } };
}

/**
 * What a Locale resolves to. An unregistered Locale is `missing` — a hole,
 * never English. See `resolveBundle` for a registered Locale's holes.
 */
export function resolveRecognition(locale: string): RecognitionResolution {
  const bundle = isRecognitionLocale(locale) ? REGISTRY[locale] : undefined;
  if (!bundle) return { status: "missing", locale };
  return resolveBundle(bundle);
}

/**
 * The whole bundle a Locale matches with, or `null` when it is not whole.
 * Never another key's words: an incomplete rendering matches nothing rather
 * than quietly matching English. Automatic detection is the caller's decision
 * (`EN_RECOGNITION`, the documented exception), not this function's.
 */
export function completeRecognitionFor(locale: string): CompleteRecognition | null {
  const resolution = resolveRecognition(locale);
  return resolution.status === "complete" ? resolution.recognition : null;
}
