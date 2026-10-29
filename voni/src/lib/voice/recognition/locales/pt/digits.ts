import type { Digit, RecognitionSlotValues } from "../../types";

/**
 * Portuguese digits, keyed by the number they mean. "três" and "tres" are the
 * same digit: speech-to-text may or may not write the accent.
 */
export const PT_DIGITS: Readonly<Record<Digit, readonly string[]>> = {
  0: ["zero"],
  1: ["um"],
  2: ["dois"],
  3: ["três", "tres"],
  4: ["quatro"],
  5: ["cinco"],
  6: ["seis"],
  7: ["sete"],
  8: ["oito"],
  9: ["nove"],
} satisfies RecognitionSlotValues["digits"];
