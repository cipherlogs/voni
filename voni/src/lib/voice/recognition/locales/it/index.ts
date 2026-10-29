import type { RecognitionSlots } from "../../types";
import {
  IT_BARGE_IN,
  IT_COMMANDS,
  IT_END_CALL,
  IT_FILLER,
  IT_GOODBYE,
} from "./filler";
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
  filler: IT_FILLER,
  bargeIn: IT_BARGE_IN,
  commands: IT_COMMANDS,
  endCall: IT_END_CALL,
  goodbye: IT_GOODBYE,
};
