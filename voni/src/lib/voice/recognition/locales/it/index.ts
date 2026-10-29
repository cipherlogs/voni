import type { RecognitionSlots } from "../../types";
import { IT_SCENE } from "./scene";
import { IT_VOCABULARY } from "./vocabulary";
import { IT_ADDRESS } from "./address";
import { IT_DIGITS } from "./digits";

/**
 * Italian recognition: the slots Italian renders so far. Absent slots are holes,
 * named by `resolveRecognition("it")`, never filled from English.
 */
export const IT_RECOGNITION: RecognitionSlots = {
  vocabulary: IT_VOCABULARY,
  scene: IT_SCENE,
  digits: IT_DIGITS,
  address: IT_ADDRESS,
};
