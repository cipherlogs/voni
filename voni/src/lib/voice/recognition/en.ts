import type { CompleteRecognition } from "./types";

/**
 * English as one rendering among six.
 *
 * Every word here is English. Nothing in this file is the shape of a question:
 * the slots, the digit values, the address roles and the command intents are
 * defined in `./types.ts`; this file only supplies their English words. A
 * rendering for another Locale is a sibling file with the same shape, and a
 * missing sibling is a hole — never this file.
 *
 * The words are the ones the product shipped before the Locale split, moved
 * here verbatim so English behaviour is unchanged. The goodbyes that were once
 * carried here in Spanish, German, French and Portuguese now belong to those
 * Locales (see the parity tickets); English no longer claims them.
 */

/** "A clinic coordinator phone call." — describes the call the recogniser is hearing. */
const scene: CompleteRecognition["scene"] = ({ agentName, role, mission, topics }) =>
  `A ${role} phone call. ${mission} Agent ${agentName}.` +
  (topics.length > 0 ? ` Callers mention ${topics.join(", ")}.` : "");

export const EN_RECOGNITION: CompleteRecognition = {
  locale: "en",
  /** The product name and the channels it answers on: right in any Locale, said in English. */
  vocabulary: ["Voni", "WhatsApp"],
  scene,
  digits: {
    0: ["zero"],
    1: ["one"],
    2: ["two"],
    3: ["three"],
    4: ["four"],
    5: ["five"],
    6: ["six"],
    7: ["seven"],
    8: ["eight"],
    9: ["nine"],
  },
  /** "andres at casaverde dot pt" — the separators a spoken address is written with. */
  address: {
    at: ["at"],
    dot: ["dot"],
    hyphen: ["dash", "hyphen"],
    underscore: ["underscore"],
  },
  /** Back-channels: breath mishears, continuers, assent. Never content. */
  filler: [
    "uh", "huh", "uhhuh", "um", "umm", "uhm", "er", "erm",
    "hmm", "hm", "ah", "oh", "mhm", "mmhm", "mmhmm", "mm",
    "yup", "okay", "ok", "right", "alright", "sure",
    "gotcha", "got", "it", "thanks",
  ],
  /**
   * Speech over the agent that never takes the floor: continuers, assent and
   * reactions. These are ignored even though they are not plain filler — a
   * bare "yes" is not a barge-in, it waits for the settled final.
   */
  bargeIn: ["so", "well", "like", "yeah", "yes", "yep", "cool", "nice", "wow", "ok"],
  /**
   * Steering. "yes"/"yeah" are deliberately absent: assent is not a command,
   * it waits for the settled final's soft-confirm path.
   */
  commands: {
    stop: ["stop", "hold on", "hang on"],
    wait: ["wait"],
    deny: ["no", "nope"],
    repeat: ["repeat", "again"],
    listen: ["listen"],
    interject: ["sorry", "excuse me"],
  },
  endCall: [
    "hang up", "end the call", "end this call", "end call", "gotta go", "got to go", "have to go",
    "bye", "goodbye",
  ],
  goodbye: ["bye", "goodbye", "see you", "talk soon", "take care"],
};
