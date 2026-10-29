import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";
import { EN_RECOGNITION } from "./en";
import {
  RECOGNITION_SLOTS,
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
};

/** Whether `value` is a spoken Locale recognition can be keyed by. */
export function isRecognitionLocale(value: string): value is RecognitionLocale {
  return (CONVERSATION_LANGUAGES as readonly string[]).includes(value);
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
