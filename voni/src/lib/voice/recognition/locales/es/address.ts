import type { AddressSeparator, RecognitionSlotValues } from "../../types";

/**
 * Spanish speech for an address's punctuation, keyed by the separator it
 * stands for ("andres arroba casaverde punto com"). The role is the contract's;
 * these are only Spanish's words for it.
 *
 * "guion bajo" is a whole separator, not "guion" followed by "bajo": the
 * normalizer prefers the longest spoken form, so an underscore never decays
 * into a hyphen.
 */
export const ES_ADDRESS: Readonly<Record<AddressSeparator, readonly string[]>> = {
  at: ["arroba"],
  dot: ["punto"],
  hyphen: ["guion", "guión"],
  underscore: ["guion bajo", "guión bajo", "barra baja", "subrayado"],
} satisfies RecognitionSlotValues["address"];
