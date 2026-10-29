import type { RecognitionSlots } from "../../types";
import {
  DE_BARGE_IN,
  DE_COMMANDS,
  DE_END_CALL,
  DE_FILLER,
  DE_GOODBYE,
} from "./filler";
import { DE_SCENE } from "./scene";
import { DE_VOCABULARY } from "./vocabulary";
import { DE_ADDRESS } from "./address";
import { DE_DIGITS } from "./digits";

/**
 * German recognition: the slots German renders so far. Absent slots are holes,
 * named by `resolveRecognition("de")`, never filled from English.
 */
export const DE_RECOGNITION: RecognitionSlots = {
  vocabulary: DE_VOCABULARY,
  scene: DE_SCENE,
  digits: DE_DIGITS,
  address: DE_ADDRESS,
  filler: DE_FILLER,
  bargeIn: DE_BARGE_IN,
  commands: DE_COMMANDS,
  endCall: DE_END_CALL,
  goodbye: DE_GOODBYE,
};
