/**
 * The comprehension evaluators' one text layer: turn the caller's authored
 * words into the exact entities a tool or a transcript must carry.
 *
 * The caller corpus is authored, so the grammar is the corpus's, not a general
 * dictation parser. An email is spoken as a local part and domain separated by
 * `at`, with `dot` for a full stop and letters spelled one at a time:
 *
 *   "j dot c h e n at example dot com" -> j.chen@example.com
 *
 * A number is a digit string, or digits spoken one at a time:
 *
 *   "4 1 5 2 0 8 7 6" -> 41520876
 *
 * Anything outside that grammar yields no entity. Refusing to guess is the
 * point: an entity the corpus did not author is unmeasured, never a pass.
 */

import type { Locale } from "../../../scenarios";

const STOP_WORDS = new Set([
  "actually",
  "address",
  "and",
  "are",
  "at",
  "be",
  "but",
  "call",
  "correct",
  "correction",
  "email",
  "for",
  "from",
  "he",
  "her",
  "his",
  "is",
  "it",
  "its",
  "me",
  "my",
  "name",
  "new",
  "no",
  "not",
  "ok",
  "okay",
  "old",
  "on",
  "or",
  "please",
  "right",
  "she",
  "so",
  "sorry",
  "spell",
  "spelled",
  "thank",
  "thanks",
  "that",
  "the",
  "them",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "wrong",
  "yes",
  "you",
  "your",
]);

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/** Common function words from the Locale core, used only to flag a leak. */
const ENGLISH_MARKERS = new Set([
  "and",
  "are",
  "can",
  "fine",
  "for",
  "have",
  "hello",
  "i",
  "is",
  "need",
  "please",
  "sorry",
  "sure",
  "thank",
  "thanks",
  "that",
  "the",
  "this",
  "want",
  "we",
  "what",
  "when",
  "where",
  "will",
  "with",
  "you",
  "your",
]);

const NON_ENGLISH_MARKERS = new Set([
  "besoin",
  "bitte",
  "bonjour",
  "buenas",
  "buenos",
  "claro",
  "cómo",
  "cuándo",
  "danke",
  "dónde",
  "gracias",
  "hallo",
  "hola",
  "ich",
  "können",
  "merci",
  "necesito",
  "nein",
  "não",
  "obrigada",
  "obrigado",
  "olá",
  "oui",
  "perfecto",
  "pode",
  "pouvez",
  "preciso",
  "puede",
  "quiero",
  "sim",
  "você",
  "vous",
  "wir",
]);

/** Tokens of one sentence, case-folded and stripped of punctuation. */
function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** The corpus ends a clause with `.`, `!`, `?` or `;`; an address never spans one. */
function sentencesOf(text: string): string[][] {
  return text
    .split(/[.!?;]+/)
    .map(tokensOf)
    .filter((tokens) => tokens.length > 0);
}

function isLetter(token: string): boolean {
  return /^[a-z]$/.test(token);
}

function isWord(token: string): boolean {
  return /^[a-z0-9]+$/.test(token);
}

function joinSegment(tokens: readonly string[]): string | null {
  if (tokens.length === 0) return null;
  if (tokens.every(isLetter)) return tokens.join("");
  if (tokens.length === 1 && isWord(tokens[0])) return tokens[0];
  return null;
}

function splitOnDot(tokens: readonly string[]): string[][] | null {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token === "dot") {
      if (current.length === 0) return null;
      segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length === 0) return null;
  segments.push(current);
  return segments;
}

/** The domain after `at`, up to the first word that starts a new clause. */
function parseDomain(tokens: readonly string[]): string | null {
  const kept: string[] = [];
  for (const token of tokens) {
    if (STOP_WORDS.has(token)) break;
    kept.push(token);
  }
  const segments = splitOnDot(kept);
  if (segments === null || segments.length < 2) return null;
  const labels = segments.map(joinSegment);
  if (labels.some((label) => label === null)) return null;
  const domain = labels.join(".");
  const tld = labels[labels.length - 1] as string;
  if (!/^[a-z]{2,}$/.test(tld)) return null;
  return domain;
}

/** The local part before `at`, walking back over the spelled words only. */
function parseLocal(tokens: readonly string[]): string | null {
  const kept: string[] = [];
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (STOP_WORDS.has(token)) break;
    if (!isWord(token)) break;
    kept.unshift(token);
  }
  const segments = splitOnDot(kept);
  if (segments === null) return null;
  const labels = segments.map(joinSegment);
  if (labels.some((label) => label === null)) return null;
  const local = labels.join(".");
  if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(local)) return null;
  return local;
}

/** Every address in the text, in the order it is spoken. */
export function canonicalEmails(text: string): string[] {
  const emails: string[] = [];
  for (const tokens of sentencesOf(text)) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== "at") continue;
      const domain = parseDomain(tokens.slice(index + 1));
      if (domain === null) continue;
      const local = parseLocal(tokens.slice(0, index));
      if (local === null) continue;
      emails.push(`${local}@${domain}`);
    }
  }
  return emails;
}

/** The last complete address, which is the corrected one when the caller repeats. */
export function lastCanonicalEmail(text: string): string | null {
  const emails = canonicalEmails(text);
  return emails.length === 0 ? null : (emails[emails.length - 1] as string);
}

/**
 * Every number the caller spelled in a form this corpus authors: a digit run,
 * or single digits spoken one at a time. A prose number ("one of", "at ten")
 * is not a readback entity and is ignored rather than guessed.
 */
export function canonicalNumbers(text: string): string[] {
  const numbers: string[] = [];
  const tokens = tokensOf(text);
  let run = "";

  const flush = () => {
    if (run.length >= 4) numbers.push(run);
    run = "";
  };

  for (const token of tokens) {
    const digit = DIGIT_WORDS[token];
    if (digit !== undefined) {
      run += digit;
      continue;
    }
    if (/^[0-9]+$/.test(token)) {
      run += token;
      continue;
    }
    flush();
  }
  flush();
  return numbers;
}

/** Case-folded words with every punctuation mark removed. */
export function normalizeWords(text: string): string[] {
  return tokensOf(text);
}

/** Word-level edit distance and its rate against the reference word count. */
export function wordError(
  reference: string,
  hypothesis: string,
): { errors: number; words: number; rate: number } {
  const expected = normalizeWords(reference);
  const heard = normalizeWords(hypothesis);
  const rows = expected.length + 1;
  const columns = heard.length + 1;
  const distance: number[][] = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) distance[row][0] = row;
  for (let column = 0; column < columns; column += 1) distance[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = expected[row - 1] === heard[column - 1] ? 0 : 1;
      distance[row][column] = Math.min(
        distance[row - 1][column] + 1,
        distance[row][column - 1] + 1,
        distance[row - 1][column - 1] + substitution,
      );
    }
  }
  const errors = distance[rows - 1][columns - 1];
  const words = expected.length;
  return { errors, words, rate: words === 0 ? 0 : errors / words };
}

/** The name the caller introduced themselves with, or null when they gave none. */
export function spokenName(text: string): string | null {
  const match = /(?:my name is|the name is|name is)\s+([a-z][a-z'-]*)/i.exec(text);
  return match === null ? null : (match[1] as string).toLowerCase();
}

/**
 * Marker words from the wrong Locale. The lexicon is the corpus's, not a
 * language detector: a paraphrase outside it yields no leak, which is a
 * recorded limitation rather than a claim that the reply is clean.
 */
export function languageLeaks(text: string, locale: Locale): string[] {
  const markers = locale === "en" ? NON_ENGLISH_MARKERS : ENGLISH_MARKERS;
  return tokensOf(text).filter((token) => markers.has(token));
}
