import type { RecognitionSlots } from "../../types";
import { DE_VOCABULARY } from "./vocabulary";
import { DE_ADDRESS } from "./address";
import { DE_DIGITS } from "./digits";

/**
 * German recognition: the slots German renders so far. Absent slots are holes,
 * named by `resolveRecognition("de")`, never filled from English.
 */
export const DE_RECOGNITION: RecognitionSlots = {
  vocabulary: DE_VOCABULARY,
  digits: DE_DIGITS,
  address: DE_ADDRESS,
};
