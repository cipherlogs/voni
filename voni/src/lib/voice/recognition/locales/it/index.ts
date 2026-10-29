import type { RecognitionSlots } from "../../types";
import { IT_VOCABULARY } from "./vocabulary";
import { IT_ADDRESS } from "./address";
import { IT_DIGITS } from "./digits";

/**
 * Italian recognition: the slots Italian renders so far. Absent slots are holes,
 * named by `resolveRecognition("it")`, never filled from English.
 */
export const IT_RECOGNITION: RecognitionSlots = {
  vocabulary: IT_VOCABULARY,
  digits: IT_DIGITS,
  address: IT_ADDRESS,
};
