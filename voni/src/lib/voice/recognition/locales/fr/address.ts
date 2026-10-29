import type { AddressSeparator, RecognitionSlotValues } from "../../types";

/**
 * French speech for an address's punctuation, keyed by the separator it stands
 * for ("andres arobase casaverde point com").
 *
 * "tiret bas" is a whole separator, so the longest spoken form wins and an
 * underscore never decays into a hyphen.
 */
export const FR_ADDRESS: Readonly<Record<AddressSeparator, readonly string[]>> = {
  at: ["arobase", "arrobe"],
  dot: ["point"],
  hyphen: ["tiret"],
  underscore: ["tiret bas", "souligné", "souligne"],
} satisfies RecognitionSlotValues["address"];
