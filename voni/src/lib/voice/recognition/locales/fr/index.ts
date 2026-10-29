import type { RecognitionSlots } from "../../types";
import {
  FR_BARGE_IN,
  FR_COMMANDS,
  FR_END_CALL,
  FR_FILLER,
  FR_GOODBYE,
} from "./filler";
import { FR_VOCABULARY } from "./vocabulary";

/**
 * French recognition: the slots French renders so far. Absent slots are holes,
 * named by `resolveRecognition("fr")`, never filled from English.
 */
export const FR_RECOGNITION: RecognitionSlots = {
  vocabulary: FR_VOCABULARY,
  filler: FR_FILLER,
  bargeIn: FR_BARGE_IN,
  commands: FR_COMMANDS,
  endCall: FR_END_CALL,
  goodbye: FR_GOODBYE,
};
