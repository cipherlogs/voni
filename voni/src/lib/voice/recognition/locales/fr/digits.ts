import type { Digit, RecognitionSlotValues } from "../../types";

/**
 * French digits, keyed by the number they mean: "quatre deux" is a Test tag's
 * 42, said in French. Accented and unaccented spellings both count, because
 * speech-to-text disagrees about them.
 */
export const FR_DIGITS: Readonly<Record<Digit, readonly string[]>> = {
  0: ["zéro", "zero"],
  1: ["un"],
  2: ["deux"],
  3: ["trois"],
  4: ["quatre"],
  5: ["cinq"],
  6: ["six"],
  7: ["sept"],
  8: ["huit"],
  9: ["neuf"],
} satisfies RecognitionSlotValues["digits"];
