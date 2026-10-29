import type { RecognitionSlots } from "../../types";
import { FR_VOCABULARY } from "./vocabulary";

/**
 * French recognition: the slots French renders so far. Absent slots are holes,
 * named by `resolveRecognition("fr")`, never filled from English.
 */
export const FR_RECOGNITION: RecognitionSlots = {
  vocabulary: FR_VOCABULARY,
};
