import type { RecognitionSlotValues } from "../../types";

/**
 * Italian filler, barge-in, steering and goodbye words.
 *
 * The meanings are the contract's (`../../types.ts`): a back-channel is never
 * content, a barge-in never takes the floor, a command intent is steering, an
 * end-call form is the caller asking to hang up, a goodbye is the agent's own
 * closing line. This file only supplies Italian's words for them.
 *
 * No English word belongs here: an Italian call primed with English guardrails
 * silently answers a passing "okay" and misses a plain "fermati". English-only
 * steering ("stop", "wait", "bye") may not appear.
 */

/** Back-channels and assent: breath mishears, continuers, "allora", "ecco". Never content. */
export const IT_FILLER: readonly string[] = [
  "eh", "ehm", "mmm", "cioè", "allora", "dunque", "ecco", "bene",
  "vabbè", "vabbe", "grazie", "capito",
];

/**
 * Speech over the agent that never takes the floor: assent and reactions.
 * "Sì" sits here, not in `commands`: agreement is not steering.
 */
export const IT_BARGE_IN: readonly string[] = [
  "sì", "si", "certo", "vero", "già", "gia", "bene", "dai", "perfetto", "ah", "oh",
];

/** Steering, keyed by intent. "Sì" is deliberately absent: assent is not a command. */
export const IT_COMMANDS: RecognitionSlotValues["commands"] = {
  stop: ["fermo", "fermati", "fermate", "basta"],
  wait: ["aspetta", "aspetti", "un momento", "un attimo"],
  deny: ["no", "niente"],
  repeat: ["ripeti", "ripeta", "ripetere", "ancora", "di nuovo"],
  listen: ["ascolta", "ascolti", "senti"],
  interject: ["scusa", "scusi", "mi scusi", "perdono"],
};

/** The caller asking to end the call, in Italian. */
export const IT_END_CALL: readonly string[] = [
  "riaggancia", "riagganciare", "chiudi la chiamata", "chiudere la chiamata",
  "termina la chiamata", "arrivederci", "ciao", "devo andare", "a presto",
];

/** The agent's own closing line, in Italian. Narrower than an end request. */
export const IT_GOODBYE: readonly string[] = [
  "arrivederci", "ciao", "a presto", "a dopo", "ci vediamo", "stammi bene", "buona giornata",
];
