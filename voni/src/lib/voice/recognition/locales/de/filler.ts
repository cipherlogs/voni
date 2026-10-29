import type { RecognitionSlotValues } from "../../types";

/**
 * German filler, barge-in, steering and goodbye words.
 *
 * The meanings are the contract's (`../../types.ts`): a back-channel is never
 * content, a barge-in never takes the floor, a command intent is steering, an
 * end-call form is the caller asking to hang up, a goodbye is the agent's own
 * closing line. This file only supplies German's words for them.
 *
 * No English word belongs here: a German call primed with English guardrails
 * silently answers a passing "okay" and misses a plain "stopp". English-only
 * steering ("stop", "wait", "bye") may not appear.
 */

/** Back-channels and assent: breath mishears, continuers, "also", "genau". Never content. */
export const DE_FILLER: readonly string[] = [
  "äh", "ähm", "hm", "hmm", "also", "genau", "stimmt", "gut",
  "danke", "klar", "toll",
];

/**
 * Speech over the agent that never takes the floor: assent and reactions.
 * "Ja" sits here, not in `commands`: agreement is not steering.
 */
export const DE_BARGE_IN: readonly string[] = [
  "ja", "jep", "genau", "stimmt", "klar", "toll", "prima", "ach", "oh",
];

/** Steering, keyed by intent. "Ja" is deliberately absent: assent is not a command. */
export const DE_COMMANDS: RecognitionSlotValues["commands"] = {
  stop: ["stopp", "halt", "anhalten"],
  wait: ["warte", "warten", "einen moment", "moment", "warten sie"],
  deny: ["nein", "nee", "nö"],
  repeat: ["wiederhole", "wiederholen", "nochmal", "noch einmal"],
  listen: ["hör zu", "hören sie zu", "zuhören"],
  interject: ["entschuldigung", "entschuldigen sie", "verzeihung"],
};

/** The caller asking to end the call, in German. */
export const DE_END_CALL: readonly string[] = [
  "auflegen", "leg auf", "beenden sie den anruf", "anruf beenden",
  "tschüss", "tschuss", "auf wiederhören", "ich muss los", "ich muss gehen", "bis bald",
];

/** The agent's own closing line, in German. Narrower than an end request. */
export const DE_GOODBYE: readonly string[] = [
  "tschüss", "tschuss", "auf wiedersehen", "auf wiederhören", "bis bald",
  "bis später", "machs gut", "alles gute",
];
