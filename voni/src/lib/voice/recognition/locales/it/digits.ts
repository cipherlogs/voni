import type { Digit, RecognitionSlotValues } from "../../types";

/** Italian digits, keyed by the number they mean. */
export const IT_DIGITS: Readonly<Record<Digit, readonly string[]>> = {
  0: ["zero"],
  1: ["uno"],
  2: ["due"],
  3: ["tre"],
  4: ["quattro"],
  5: ["cinque"],
  6: ["sei"],
  7: ["sette"],
  8: ["otto"],
  9: ["nove"],
} satisfies RecognitionSlotValues["digits"];
