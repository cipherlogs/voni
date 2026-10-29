import type { RecognitionSlotValues } from "../../types";

/**
 * Spanish filler, barge-in, steering and goodbye words.
 *
 * The meanings are the contract's (`../../types.ts`): a back-channel is never
 * content, a barge-in never takes the floor, a command intent is steering, an
 * end-call form is the caller asking to hang up, a goodbye is the agent's own
 * closing line. This file only supplies Spanish's words for them.
 *
 * No English word belongs here: a Spanish call primed with English guardrails
 * silently answers a passing "okay" and misses a plain "para". The shared
 * spellings ("no", "ok") are Spanish words too, so they may appear; the
 * English-only steering ("stop", "wait", "bye") may not.
 */

/** Back-channels and assent: breath mishears, continuers, "vale", "pues". Never content. */
export const ES_FILLER: readonly string[] = [
  "eh", "em", "mmm", "hmm", "este", "pues", "bueno", "ya",
  "ajá", "vale", "ok", "claro", "perfecto", "gracias", "entiendo",
];

/**
 * Speech over the agent that never takes the floor: assent and reactions.
 * "Sí" sits here, not in `commands`: agreement is not steering, it waits for
 * the settled final.
 */
export const ES_BARGE_IN: readonly string[] = [
  "sí", "claro", "bueno", "pues", "venga", "dale", "genial", "perfecto", "vaya", "ah", "oh",
];

/**
 * Steering, keyed by intent. "Sí" is deliberately absent: assent is not a
 * command. A caller can carry more than one ("perdón, repite eso").
 */
export const ES_COMMANDS: RecognitionSlotValues["commands"] = {
  stop: ["para", "detente", "alto"],
  wait: ["espera", "espera un momento", "un momento", "aguarda"],
  deny: ["no", "nop", "para nada"],
  repeat: ["repite", "repetir", "otra vez", "de nuevo"],
  listen: ["escucha", "escúchame", "oiga"],
  interject: ["perdón", "perdona", "disculpa", "disculpe"],
};

/** The caller asking to end the call, in Spanish. */
export const ES_END_CALL: readonly string[] = [
  "cuelga", "cuelgue", "fin de la llamada", "termina la llamada", "terminar la llamada",
  "adiós", "chao", "hasta luego", "me tengo que ir", "tengo que irme", "ya me voy",
];

/** The agent's own closing line, in Spanish. Narrower than an end request. */
export const ES_GOODBYE: readonly string[] = [
  "adiós", "hasta luego", "hasta pronto", "nos vemos", "cuídate", "chao",
  "que tengas un buen día",
];
