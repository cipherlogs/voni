import type { Digit, RecognitionSlotValues } from "../../types";

/**
 * German digits, keyed by the number they mean. "fünf" and "funf" are the same
 * digit: speech-to-text may or may not write the umlaut.
 */
export const DE_DIGITS: Readonly<Record<Digit, readonly string[]>> = {
  0: ["null"],
  1: ["eins"],
  2: ["zwei"],
  3: ["drei"],
  4: ["vier"],
  5: ["fünf", "funf"],
  6: ["sechs"],
  7: ["sieben"],
  8: ["acht"],
  9: ["neun"],
} satisfies RecognitionSlotValues["digits"];
