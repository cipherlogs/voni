import type { RecognitionLocale, RecognitionSlots } from "../types";
import { DE_RECOGNITION } from "./de";
import { ES_RECOGNITION } from "./es";
import { FR_RECOGNITION } from "./fr";
import { IT_RECOGNITION } from "./it";
import { PT_RECOGNITION } from "./pt";

/**
 * Every spoken Locale except English, as its Locale folder renders it.
 *
 * English lives at `../en.ts` as the template it always was; these five are the
 * Locales that arrive one slot at a time. A Locale here with a slot absent is
 * an incomplete rendering, reported as such — never a reason to read English.
 */
export const LOCALE_RECOGNITION: Record<Exclude<RecognitionLocale, "en">, RecognitionSlots> = {
  es: ES_RECOGNITION,
  fr: FR_RECOGNITION,
  de: DE_RECOGNITION,
  it: IT_RECOGNITION,
  pt: PT_RECOGNITION,
};

export { DE_RECOGNITION, ES_RECOGNITION, FR_RECOGNITION, IT_RECOGNITION, PT_RECOGNITION };
