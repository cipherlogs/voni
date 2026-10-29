import type { AddressSeparator, RecognitionSlotValues } from "../../types";

/**
 * German speech for an address's punctuation, keyed by the separator it stands
 * for ("andres klammeraffe casaverde punkt com"). "at zeichen" is the German
 * name of the @ sign, said as two words.
 */
export const DE_ADDRESS: Readonly<Record<AddressSeparator, readonly string[]>> = {
  at: ["klammeraffe", "at zeichen"],
  dot: ["punkt"],
  hyphen: ["bindestrich", "minus"],
  underscore: ["unterstrich"],
} satisfies RecognitionSlotValues["address"];
