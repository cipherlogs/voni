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
  type SceneRenderer,
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
 * No words at all, filled slot by slot. A Locale that has not rendered a slot
 * matches nothing there — never English's words.
 */
const NO_WORDS: Omit<CompleteRecognition, "locale"> = {
  vocabulary: [],
  scene: () => "",
  digits: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [] },
  address: { at: [], dot: [], hyphen: [], underscore: [] },
  filler: [],
  bargeIn: [],
  commands: { stop: [], wait: [], deny: [], repeat: [], listen: [], interject: [] },
  endCall: [],
  goodbye: [],
};

/**
 * The recognition a call runs under, for the code that has to decide *now* —
 * a barge-in, a back-channel, a goodbye — from what the call says about its
 * Locale.
 *
 * - A pinned Locale is that Locale's own words. A slot it has not rendered yet
 *   contributes nothing (see `NO_WORDS`): a hole matches nothing, which is a
 *   visible miss, while English words would be a silent wrong call. The hole
 *   itself is reported by `resolveRecognition` / `recognitionCompleteness`.
 * - Automatic detection (nothing pinned) is the one documented English
 *   scaffolding exception, the same one `NEUTRAL_KEYTERMS` records: the
 *   recogniser cannot know the Locale before the caller speaks, and a guardrail
 *   with no words at all would answer every "okay".
 */
export function callRecognition(source: CallLanguageSource): CompleteRecognition {
  const locale = callRecognitionLocale(source);
  if (locale === null) return EN_RECOGNITION;
  return { ...NO_WORDS, ...(REGISTRY[locale]?.slots ?? {}), locale };
}

/**
 * The vocabulary a Locale is primed with, or `undefined` when the Locale has
 * no vocabulary rendering yet. A hole stays a hole; an absent Locale never
 * resolves to English's words.
 */
export function recognitionVocabulary(locale: string): readonly string[] | undefined {
  return isRecognitionLocale(locale) ? REGISTRY[locale]?.slots.vocabulary : undefined;
}

/**
 * The scene a Locale describes its call with, or `undefined` when the Locale has
 * no scene rendering yet. Like vocabulary, a hole stays a hole: an absent scene
 * never resolves to English's description, and `recognitionCompleteness` names
 * it.
 */
export function recognitionScene(locale: string): SceneRenderer | undefined {
  return isRecognitionLocale(locale) ? REGISTRY[locale]?.slots.scene : undefined;
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
