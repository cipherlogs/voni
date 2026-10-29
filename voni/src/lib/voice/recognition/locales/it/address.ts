import type { AddressSeparator, RecognitionSlotValues } from "../../types";

/**
 * Italian speech for an address's punctuation, keyed by the separator it stands
 * for ("andres chiocciola casaverde punto com").
 *
 * "trattino basso" is a whole separator, so the longest spoken form wins and an
 * underscore never decays into a hyphen.
 */
export const IT_ADDRESS: Readonly<Record<AddressSeparator, readonly string[]>> = {
  at: ["chiocciola"],
  dot: ["punto"],
  hyphen: ["trattino", "lineetta"],
  underscore: ["trattino basso", "sottolineato"],
} satisfies RecognitionSlotValues["address"];
