import type { RecognitionSlots } from "../../types";
import { ES_VOCABULARY } from "./vocabulary";

/**
 * Spanish recognition: the slots Spanish renders so far.
 *
 * A slot absent here is a real hole and `resolveRecognition("es")` names it;
 * nothing fills it from English. Sibling slot files land with their own
 * tickets (scene, digits/address, filler/commands/goodbyes).
 */
export const ES_RECOGNITION: RecognitionSlots = {
  vocabulary: ES_VOCABULARY,
};
