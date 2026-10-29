import type { RecognitionSlotValues } from "../../types";

/**
 * Portuguese filler, barge-in, steering and goodbye words.
 *
 * The meanings are the contract's (`../../types.ts`): a back-channel is never
 * content, a barge-in never takes the floor, a command intent is steering, an
 * end-call form is the caller asking to hang up, a goodbye is the agent's own
 * closing line. This file only supplies Portuguese's words for them.
 *
 * No English word belongs here: a Portuguese call primed with English
 * guardrails silently answers a passing "okay" and misses a plain "para".
 * English-only steering ("stop", "wait", "bye") may not appear.
 */

/** Back-channels and assent: breath mishears, continuers, "pois", "então". Never content. */
export const PT_FILLER: readonly string[] = [
  "eh", "hmm", "hum", "pois", "bom", "então", "entao", "pronto",
  "certo", "obrigado", "obrigada", "entendi",
];

/**
 * Speech over the agent that never takes the floor: assent and reactions.
 * "Sim" sits here, not in `commands`: agreement is not steering.
 */
export const PT_BARGE_IN: readonly string[] = [
  "sim", "claro", "pois", "certo", "legal", "bacana", "massa", "ah", "oh", "então",
];

/** Steering, keyed by intent. "Sim" is deliberately absent: assent is not a command. */
export const PT_COMMANDS: RecognitionSlotValues["commands"] = {
  stop: ["para", "pare", "chega"],
  wait: ["espera", "espere", "um momento", "calma", "aguarda"],
  deny: ["não", "nao"],
  repeat: ["repete", "repita", "de novo", "outra vez"],
  listen: ["escuta", "escute", "ouça", "ouca"],
  interject: ["desculpa", "desculpe", "perdão", "perdao", "com licença"],
};

/** The caller asking to end the call, in Portuguese. */
export const PT_END_CALL: readonly string[] = [
  "desliga", "desligue", "desligar", "encerra a chamada", "encerrar a chamada",
  "tchau", "até logo", "ate logo", "tenho que ir", "preciso ir",
];

/** The agent's own closing line, in Portuguese. Narrower than an end request. */
export const PT_GOODBYE: readonly string[] = [
  "tchau", "até logo", "até breve", "até mais", "nos vemos", "se cuida", "tenha um bom dia",
];
