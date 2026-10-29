import type { AddressSeparator, RecognitionSlotValues } from "../../types";

/**
 * Portuguese speech for an address's punctuation, keyed by the separator it
 * stands for ("andres arroba casaverde ponto com").
 *
 * "traço baixo" is a whole separator, so the longest spoken form wins and an
 * underscore never decays into a hyphen. Accented and unaccented spellings both
 * count.
 */
export const PT_ADDRESS: Readonly<Record<AddressSeparator, readonly string[]>> = {
  at: ["arroba"],
  dot: ["ponto"],
  hyphen: ["hífen", "hifen", "traço", "traco"],
  underscore: ["traço baixo", "traco baixo", "sublinhado"],
} satisfies RecognitionSlotValues["address"];
