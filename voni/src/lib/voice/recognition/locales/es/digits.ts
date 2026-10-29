import type { Digit, RecognitionSlotValues } from "../../types";

/**
 * Spanish digits, keyed by the number they mean.
 *
 * A caller reading a Test tag's digits aloud says "cuatro dos", never "four
 * two": the meaning is the number, the words are Spanish. No English digit
 * word belongs here.
 */
export const ES_DIGITS: Readonly<Record<Digit, readonly string[]>> = {
  0: ["cero"],
  1: ["uno"],
  2: ["dos"],
  3: ["tres"],
  4: ["cuatro"],
  5: ["cinco"],
  6: ["seis"],
  7: ["siete"],
  8: ["ocho"],
  9: ["nueve"],
} satisfies RecognitionSlotValues["digits"];
