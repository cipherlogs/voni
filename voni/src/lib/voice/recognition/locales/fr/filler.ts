import type { RecognitionSlotValues } from "../../types";

/**
 * French filler, barge-in, steering and goodbye words.
 *
 * The meanings are the contract's (`../../types.ts`): a back-channel is never
 * content, a barge-in never takes the floor, a command intent is steering, an
 * end-call form is the caller asking to hang up, a goodbye is the agent's own
 * closing line. This file only supplies French's words for them.
 *
 * No English word belongs here: a French call primed with English guardrails
 * silently answers a passing "okay" and misses a plain "arrête". The shared
 * spellings ("non", "d'accord") are French words too; English-only steering
 * ("stop", "wait", "bye") may not appear.
 */

/** Back-channels and assent: breath mishears, continuers, "ben", "voilà". Never content. */
export const FR_FILLER: readonly string[] = [
  "euh", "heu", "hum", "hmm", "ben", "bah", "bon", "alors",
  "voilà", "voila", "daccord", "entendu", "merci", "mouais",
];

/**
 * Speech over the agent that never takes the floor: assent and reactions.
 * "Oui" sits here, not in `commands`: agreement is not steering.
 */
export const FR_BARGE_IN: readonly string[] = [
  "oui", "ouais", "voilà", "bon", "ben", "bah", "génial", "super", "ah", "oh",
];

/** Steering, keyed by intent. "Oui" is deliberately absent: assent is not a command. */
export const FR_COMMANDS: RecognitionSlotValues["commands"] = {
  stop: ["arrête", "arrêtez", "halte"],
  wait: ["attends", "attendez", "une seconde", "un instant", "patientez"],
  deny: ["non", "nan"],
  repeat: ["répète", "répétez", "encore", "de nouveau"],
  listen: ["écoute", "écoutez"],
  interject: ["pardon", "excusez moi", "désolé", "désolée"],
};

/** The caller asking to end the call, in French. */
export const FR_END_CALL: readonly string[] = [
  "raccroche", "raccrochez", "raccrocher", "fin de la conversation",
  "au revoir", "salut", "à plus", "je dois y aller", "je dois partir",
];

/** The agent's own closing line, in French. Narrower than an end request. */
export const FR_GOODBYE: readonly string[] = [
  "au revoir", "à bientôt", "à plus", "salut", "bonne journée",
  "prends soin de toi", "à la prochaine",
];
