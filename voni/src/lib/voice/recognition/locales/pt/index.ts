import type { RecognitionSlots } from "../../types";
import {
  PT_BARGE_IN,
  PT_COMMANDS,
  PT_END_CALL,
  PT_FILLER,
  PT_GOODBYE,
} from "./filler";
import { PT_SCENE } from "./scene";
import { PT_VOCABULARY } from "./vocabulary";

/**
 * Portuguese recognition: the slots Portuguese renders so far. Absent slots are
 * holes, named by `resolveRecognition("pt")`, never filled from English.
 */
export const PT_RECOGNITION: RecognitionSlots = {
  vocabulary: PT_VOCABULARY,
  scene: PT_SCENE,
  filler: PT_FILLER,
  bargeIn: PT_BARGE_IN,
  commands: PT_COMMANDS,
  endCall: PT_END_CALL,
  goodbye: PT_GOODBYE,
};
