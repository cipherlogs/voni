import type { RecognitionSlots } from "../../types";
import {
  ES_BARGE_IN,
  ES_COMMANDS,
  ES_END_CALL,
  ES_FILLER,
  ES_GOODBYE,
} from "./filler";
import { ES_VOCABULARY } from "./vocabulary";

/**
 * Spanish recognition: the slots Spanish renders so far.
 *
 * A slot absent here is a real hole and `resolveRecognition("es")` names it;
 * nothing fills it from English. Sibling slot files land with their own
 * tickets (scene, digits/address).
 */
export const ES_RECOGNITION: RecognitionSlots = {
  vocabulary: ES_VOCABULARY,
  filler: ES_FILLER,
  bargeIn: ES_BARGE_IN,
  commands: ES_COMMANDS,
  endCall: ES_END_CALL,
  goodbye: ES_GOODBYE,
};
