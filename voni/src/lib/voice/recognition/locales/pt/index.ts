import type { RecognitionSlots } from "../../types";
import { PT_SCENE } from "./scene";
import { PT_VOCABULARY } from "./vocabulary";

/**
 * Portuguese recognition: the slots Portuguese renders so far. Absent slots are
 * holes, named by `resolveRecognition("pt")`, never filled from English.
 */
export const PT_RECOGNITION: RecognitionSlots = {
  vocabulary: PT_VOCABULARY,
  scene: PT_SCENE,
};
