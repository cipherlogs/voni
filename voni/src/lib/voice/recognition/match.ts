import {
  ADDRESS_SEPARATORS,
  COMMAND_INTENTS,
  DIGITS,
  type AddressSeparator,
  type CommandIntent,
  type CompleteRecognition,
} from "./types";

/**
 * The match rules, owned here so every Locale is judged by the same rule over
 * its own words. Each function takes a `CompleteRecognition`: a Locale with a
 * hole has no bundle that matches, so a missing rendering can never quietly
 * match nothing (or quietly match English).
 *
 * The tokenizer is deliberately locale-neutral: lowercase, strip punctuation,
 * split on whitespace. It is the same rule the product shipped before the
 * Locale split, so English behaviour is unchanged.
 */

/** Lowercased words with punctuation removed. */
export function cleanTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether a word or a phrase is said. A one-word form is matched as a token
 * (so "no" is not found inside "nobody"); a multi-word form is matched as a
 * run of tokens (so "hold on" is).
 */
function matchesForms(text: string, forms: readonly string[]): boolean {
  const tokens = cleanTokens(text);
  if (tokens.length === 0) return false;
  const padded = ` ${tokens.join(" ")} `;
  return forms.some((form) => {
    const formTokens = cleanTokens(form);
    if (formTokens.length === 0) return false;
    return formTokens.length === 1
      ? tokens.includes(formTokens[0])
      : padded.includes(` ${formTokens.join(" ")} `);
  });
}

/** The punctuation each spoken separator stands for. */
const SEPARATOR_WRITTEN: Record<AddressSeparator, string> = {
  at: "@",
  dot: ".",
  hyphen: "-",
  underscore: "_",
};

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A caller's words with the Locale's spoken digits written as numerals:
 * "Lima cuatro dos" → "lima 42". A run of the Locale's own digit words joins
 * into one number, exactly as the tag was written ("Lima 42"); a word another
 * Locale owns stays a word, so a digit string in the wrong Locale never
 * silently resolves. Punctuation is dropped and words are single-spaced, the
 * same shape the tag matcher reads.
 */
export function spokenDigitsToNumerals(text: string, recognition: CompleteRecognition): string {
  const spoken = new Map<string, string>();
  for (const digit of DIGITS) {
    for (const form of recognition.digits[digit]) {
      const word = cleanTokens(form).join(" ");
      if (word && !spoken.has(word)) spoken.set(word, String(digit));
    }
  }
  // A hyphen between spoken digits is a pause, not a word of its own.
  const out: string[] = [];
  let run = "";
  for (const token of cleanTokens(text.replace(/[-–—]/g, " "))) {
    const digit = spoken.get(token);
    if (digit !== undefined) {
      run += digit;
      continue;
    }
    if (run) {
      out.push(run);
      run = "";
    }
    out.push(token);
  }
  if (run) out.push(run);
  return out.join(" ");
}

/**
 * A spoken address written as the visitor would type it ("andres at acme dot
 * com" → "andres@acme.com"), using this Locale's separator words and no
 * other. Accents and case are the caller's; the shape is the same.
 *
 * The longest spoken form wins, so a two-word separator ("guion bajo") is an
 * underscore and never a hyphen followed by "bajo".
 */
export function normalizeSpokenAddress(raw: string, recognition: CompleteRecognition): string {
  let text = ` ${raw.toLowerCase()} `;
  const forms = ADDRESS_SEPARATORS.flatMap((role) =>
    recognition.address[role].map((form) => ({ role, spoken: cleanTokens(form).join(" ") })),
  )
    .filter(({ spoken }) => spoken.length > 0)
    .sort((a, b) => b.spoken.length - a.spoken.length);
  for (const { role, spoken } of forms) {
    text = text.replace(new RegExp(`\\s+${escapePattern(spoken)}\\s+`, "g"), SEPARATOR_WRITTEN[role]);
  }
  return text.replace(/\s+/g, "").replace(/\.+$/, "");
}

/**
 * Every intent the caller's words carry, in `COMMAND_INTENTS` order. The
 * intent is the meaning; the words are the Locale's. A caller can carry more
 * than one ("sorry, repeat that" is both an interjection and a repeat).
 */
export function commandIntents(text: string, recognition: CompleteRecognition): CommandIntent[] {
  return COMMAND_INTENTS.filter((intent) => matchesForms(text, recognition.commands[intent]));
}

/** Steering that yields the floor (stop/wait/no/repeat/listen/interject). */
export function isCommandBargeIn(text: string, recognition: CompleteRecognition): boolean {
  return commandIntents(text, recognition).length > 0;
}

/**
 * A pure back-channel: every word is filler, so it is never answered. Elongation
 * ("okaay") is a caller's own rule at the call site, not a word repertoire.
 */
export function isFillerOnly(text: string, recognition: CompleteRecognition): boolean {
  const tokens = cleanTokens(text);
  if (tokens.length === 0) return false;
  const filler = new Set(recognition.filler.map((word) => cleanTokens(word).join(" ")).filter(Boolean));
  return tokens.every((token) => filler.has(token));
}

/** The caller asking to end the call, in this Locale. */
export function isEndCallRequest(text: string, recognition: CompleteRecognition): boolean {
  return matchesForms(text, recognition.endCall);
}

/**
 * An agent line that is a goodbye ("Okay, bye!", "Take care"). Narrower than
 * `isEndCallRequest`: a request phrase like "hang up" is the caller's intent,
 * not the agent's closing line.
 */
export function isGoodbyeLine(text: string, recognition: CompleteRecognition): boolean {
  return matchesForms(text, recognition.goodbye);
}
