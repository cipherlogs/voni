/**
 * Voice-parity ticket 76: the English-leak counter (spec W5).
 *
 * A call is conducted in one Locale (a voice speaks exactly one). When that
 * Locale is not English, an agent turn that says an English word is evidence
 * of code-switching — the English rendering leaking into a reply that should
 * be entirely in the call's language. This module counts those turns from the
 * artifact's own transcript and nothing else: no audio, no model, no clock.
 *
 * Report-only, by design. The counter sits beside the ratings as evidence; it
 * adds no gate, no sub-score and never moves a PASS/FAIL. It stays report-only
 * until its false-positive rate on English is known, and even then the
 * promotion is a *new* record (see `ENGLISH_LEAK_PROMOTION`), never an edit to
 * the record that shipped report-only.
 *
 * What counts, and what does not:
 * - Only a Locale the recognition registry actually speaks is scanned. English
 *   is measured (the baseline below) but never flagged; an undetermined Locale
 *   is not scanned at all, so English is never assumed.
 * - Only unambiguous English function words count. A word that is genuine in
 *   the call's own Locale ("was", "will", "am" in German; "he", "has" in
 *   Spanish; "do" in Portuguese) is not evidence of anything.
 * - A proper noun is exempt: the Locale's own recognition vocabulary (the
 *   product name, the channel), every Test-tag word, and any capitalised word
 *   that is not sentence-initial ("The Beatles" is a band; "The address…" is
 *   an English sentence opening).
 *
 * Known limitation, recorded rather than hidden: a sentence-initial English
 * word that is a proper noun ("The Beatles suenan bien.") reads as a leak.
 * That is why the counter is report-only and why the English baseline is
 * measured before anyone gates on it.
 */
import {
  isRecognitionLocale,
  recognitionVocabulary,
} from "@/lib/voice/recognition";
import { TAG_WORDS } from "./test-tag";

/**
 * The promotion decision (voice-parity 76). Report-only: this record can never
 * gate. Promotion is a NEW record appended to `ENGLISH_LEAK_PROMOTIONS` —
 * carrying the measured English false-positive rate and a stated source — and
 * this record is never edited.
 */
export type EnglishLeakPromotion = {
  readonly gating: boolean;
  /** ISO date the decision was made; null while report-only. */
  readonly decidedAt: string | null;
  /** Why the decision was made, in one line a reader can audit. */
  readonly source: string;
};

/**
 * The record that shipped with ticket 76. Frozen: promotion appends a sibling
 * record to `ENGLISH_LEAK_PROMOTIONS` instead of changing this one.
 */
export const ENGLISH_LEAK_PROMOTION: EnglishLeakPromotion = Object.freeze({
  gating: false,
  decidedAt: null,
  source:
    "voice-parity 76: report-only until the English false-positive rate is known; " +
    "promotion adds a new record beside this one and is never an edit of it",
});

/** Every promotion record, oldest first. A promotion appends; it never edits. */
export const ENGLISH_LEAK_PROMOTIONS: readonly EnglishLeakPromotion[] =
  Object.freeze([ENGLISH_LEAK_PROMOTION]);

/** The record in force: the last one appended. */
export function latestEnglishLeakPromotion(
  records: readonly EnglishLeakPromotion[] = ENGLISH_LEAK_PROMOTIONS,
): EnglishLeakPromotion {
  const active = records[records.length - 1];
  if (!active) throw new Error("no English-leak promotion record exists");
  return active;
}

/** Whether the counter is gating yet. Always false until a new record lands. */
export function englishLeakIsGating(): boolean {
  return latestEnglishLeakPromotion().gating;
}

/** One agent turn, read from the transcript's Call trace. */
export type AgentTurn = {
  sessionId: string | null;
  /** 1-based turn in that session's Call trace; null when the transcript had no header. */
  turn: number | null;
  text: string;
};

/** One agent turn that leaked English words. */
export type EnglishLeakFinding = {
  sessionId: string | null;
  turn: number | null;
  /** Distinct offending words, in the order they appeared. */
  words: string[];
  /** The agent turn's own words (caller words never reach this counter). */
  text: string;
};

/**
 * The counter's measurement on English turns. `scopedFlagged` is the counter
 * honouring its Locale guard and must stay 0; `unscopedFlagged` is what the
 * same word scan would fire at on the same English turns if the guard were
 * dropped — the cost of gating an English subject by mistake.
 */
export type EnglishLeakBaseline = {
  turns: number;
  scopedFlagged: number;
  /** scopedFlagged / turns; null when the transcript had no agent turn. */
  scopedRate: number | null;
  unscopedFlagged: number;
  /** unscopedFlagged / turns; null when the transcript had no agent turn. */
  unscopedRate: number | null;
};

export type EnglishLeakStatus =
  "clear" | "leak" | "unmeasured" | "not-applicable";

/**
 * One subject's English-leak evidence. `reportOnly` and `promotion` travel with
 * the count so no reader — artifact, report or gate — can mistake it for a
 * verdict. `englishBaseline` is non-null only on an English subject.
 */
export type EnglishLeakCount = {
  status: EnglishLeakStatus;
  /** False for English and for an undetermined Locale: the counter does not apply. */
  applicable: boolean;
  locale: string;
  /** Agent turns that leaked English words. */
  count: number;
  /** Agent turns examined. */
  turns: number;
  /** count / turns; null when the counter does not apply or read no turn. */
  rate: number | null;
  findings: EnglishLeakFinding[];
  reportOnly: true;
  promotion: EnglishLeakPromotion;
  englishBaseline: EnglishLeakBaseline | null;
};

/**
 * English words that carry no meaning in a Spanish, French, German, Italian or
 * Portuguese sentence: pronouns, auxiliaries, question words, discourse
 * markers. Content words are deliberately absent — "email", "link", "test",
 * "app" and "okay" are loanwords in the very Locales this counter reads, and
 * flagging them would be the false positive the baseline exists to expose.
 */
const ENGLISH_MARKERS: ReadonlySet<string> = new Set([
  // determiners / pronouns
  "the", "this", "that", "these", "those",
  "i", "you", "your", "yours", "yourself",
  "we", "our", "ours",
  "they", "their", "theirs", "them",
  "it", "its", "he", "him", "his", "she", "her", "hers",
  // auxiliaries and copulas
  "is", "are", "was", "were", "am", "be", "been", "being",
  "have", "has", "had", "having",
  "do", "does", "did", "doing", "done",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  // prepositions, conjunctions, question words
  "from", "about", "because",
  "what", "when", "where", "who", "whom", "whose", "why", "how", "which",
  // discourse markers and unmistakable English politeness
  "just", "really", "very", "actually", "basically",
  "please", "thanks", "thank", "welcome", "hello", "hi", "goodbye",
  "something", "anything", "everything", "nothing",
  "someone", "anyone", "everyone",
  "yes",
]);

/**
 * English markers that are ordinary words in one of the Locales this counter
 * reads. They are never evidence of a leak in that Locale.
 */
const LOCALE_FALSE_FRIENDS: Readonly<Record<string, ReadonlySet<string>>> = {
  // "was" = what, "will" = want, "am" = at the
  de: new Set(["was", "will", "am"]),
  // "he" = I have, "has" = you have
  es: new Set(["he", "has"]),
  // "i" = the (masculine plural article)
  it: new Set(["i"]),
  // "do" = of the
  pt: new Set(["do"]),
  fr: new Set<string>(),
};

/** Every Test-tag word in every Locale is a proper noun, never a leak. */
const TAG_PROPER_NOUNS: ReadonlySet<string> = new Set(
  Object.values(TAG_WORDS)
    .flat()
    .map((word) => word.toLowerCase()),
);

/**
 * The words exempt as proper nouns for one Locale: its own recognition
 * vocabulary (the product and channel names, plus the Locale's own terms) and
 * every Test-tag word. The same knowledge the recogniser is primed with.
 */
function properNouns(locale: string): ReadonlySet<string> {
  const vocabulary =
    (isRecognitionLocale(locale) ? recognitionVocabulary(locale) : undefined) ??
    [];
  return new Set([
    ...vocabulary.map((word) => word.toLowerCase()),
    ...TAG_PROPER_NOUNS,
  ]);
}

/**
 * Whether the counter applies to a Locale at all. English is the baseline, not
 * a subject this counter judges; a Locale recognition does not speak, and an
 * undetermined Locale, are not scanned — English is never assumed.
 */
export function englishLeakApplies(locale: string): boolean {
  return isRecognitionLocale(locale) && locale !== "en";
}

type TranscriptToken = {
  /** Lowercased word, punctuation stripped. */
  word: string;
  /** The word as written, so capitalisation can mark a proper noun. */
  written: string;
  /** Position in the turn; 0 is sentence-initial. */
  index: number;
};

/** Words in a turn, keeping case and position (accented letters included). */
function tokensOf(text: string): TranscriptToken[] {
  const tokens: TranscriptToken[] = [];
  for (const match of text.matchAll(/\p{L}+(?:['’]\p{L}+)?/gu)) {
    const written = match[0];
    tokens.push({ word: written.toLowerCase(), written, index: tokens.length });
  }
  return tokens;
}

/**
 * The distinct English words one turn leaks. `unscoped` drops the Locale guard
 * for the English baseline measurement only; it never changes what a report on
 * a non-English subject says.
 */
function leakedWordsIn(
  text: string,
  locale: string,
  unscoped = false,
): string[] {
  if (!unscoped && !englishLeakApplies(locale)) return [];
  const friends = LOCALE_FALSE_FRIENDS[locale] ?? new Set<string>();
  const proper = properNouns(locale);
  const found: string[] = [];
  for (const token of tokensOf(text)) {
    if (!ENGLISH_MARKERS.has(token.word)) continue;
    if (friends.has(token.word) || proper.has(token.word)) continue;
    // "I" is always written capitalised, so capitalisation cannot make it a
    // proper noun. Every other capitalised word after the first token is one
    // ("The Beatles" is a band, "the address" is a leaked sentence).
    if (token.word !== "i" && token.index > 0 && /^\p{Lu}/u.test(token.written))
      continue;
    found.push(token.word);
  }
  return [...new Set(found)];
}

const VONI_ROW = /VONI\s+"([^"]*)"/;
const SESSION_HEADER = /^\s*(sess_[A-Za-z0-9_-]+)\b/;

/**
 * Agent turns as the merged Call trace printed them: `VONI "…"` rows, numbered
 * per session. A session header (`sess_…  agent=…`) names the call the turns
 * after it belong to; without one the turns stay unattributed (null), never
 * guessed onto another session.
 */
export function agentTurnsFromTranscript(
  lines: readonly string[],
  sessionId: string | null = null,
): AgentTurn[] {
  const turns: AgentTurn[] = [];
  let currentSession = sessionId;
  let turn = 0;
  for (const line of lines) {
    const header = SESSION_HEADER.exec(line);
    if (header) {
      if (header[1] !== currentSession) turn = 0;
      currentSession = header[1] ?? currentSession;
      continue;
    }
    const row = VONI_ROW.exec(line);
    if (!row) continue;
    turn += 1;
    turns.push({ sessionId: currentSession, turn, text: row[1] ?? "" });
  }
  return turns;
}

function baselineFor(turns: readonly AgentTurn[]): EnglishLeakBaseline {
  const scopedFlagged = turns.filter(
    (turn) => leakedWordsIn(turn.text, "en").length > 0,
  ).length;
  const unscopedFlagged = turns.filter(
    (turn) => leakedWordsIn(turn.text, "en", true).length > 0,
  ).length;
  const rate = (flagged: number) =>
    turns.length === 0 ? null : flagged / turns.length;
  return {
    turns: turns.length,
    scopedFlagged,
    scopedRate: rate(scopedFlagged),
    unscopedFlagged,
    unscopedRate: rate(unscopedFlagged),
  };
}

/**
 * Count the agent turns that leak English words in one Locale. A transcript
 * with no agent turn is unmeasured (rate null), never a clean zero; English is
 * not-applicable and carries the measured baseline instead.
 */
export function countEnglishLeak(
  turns: readonly AgentTurn[],
  locale: string,
): EnglishLeakCount {
  const applicable = englishLeakApplies(locale);
  const findings: EnglishLeakFinding[] = [];
  if (applicable) {
    for (const turn of turns) {
      const words = leakedWordsIn(turn.text, locale);
      if (words.length === 0) continue;
      findings.push({
        sessionId: turn.sessionId,
        turn: turn.turn,
        words,
        text: turn.text,
      });
    }
  }
  const status: EnglishLeakStatus = !applicable
    ? "not-applicable"
    : turns.length === 0
      ? "unmeasured"
      : findings.length > 0
        ? "leak"
        : "clear";
  return {
    status,
    applicable,
    locale,
    count: findings.length,
    turns: turns.length,
    rate:
      applicable && turns.length > 0 ? findings.length / turns.length : null,
    findings,
    reportOnly: true,
    promotion: latestEnglishLeakPromotion(),
    englishBaseline: locale === "en" ? baselineFor(turns) : null,
  };
}

/** The transcript-shaped slice of an artifact this counter reads. */
export type LeakTranscriptSource = {
  readonly voice?: string;
  readonly subject?: { readonly locale: string } | null;
  readonly transcripts?: { readonly redacted: readonly string[] } | null;
  readonly callTrace?: {
    readonly sessionId: string;
    readonly excerpt: readonly string[];
    readonly sessions?: readonly {
      readonly sessionId: string;
      readonly excerpt: readonly string[];
    }[];
  } | null;
};

/** Every agent turn the artifact's transcript carries, with its session. */
function artifactAgentTurns(
  artifact: LeakTranscriptSource,
  sessionId: string | null | undefined,
): AgentTurn[] {
  const trace = artifact.callTrace;
  const traceSessions =
    trace?.sessions && trace.sessions.length > 0
      ? trace.sessions.map((session) => ({
          sessionId: session.sessionId,
          lines: session.excerpt,
        }))
      : trace
        ? [{ sessionId: trace.sessionId, lines: trace.excerpt }]
        : [];
  const fromTrace = traceSessions.flatMap((session) =>
    agentTurnsFromTranscript(session.lines, session.sessionId),
  );
  const turns =
    fromTrace.length > 0
      ? fromTrace
      : agentTurnsFromTranscript(artifact.transcripts?.redacted ?? [], null);
  return sessionId
    ? turns.filter((turn) => turn.sessionId === sessionId)
    : turns;
}

/**
 * The counter for one artifact, read from its transcript. The Locale comes from
 * the artifact's subject; a caller may pass the resolved Locale (the compact
 * report does, so a legacy artifact derives it from its voice) and a session to
 * narrow the reading. An artifact whose Locale is undetermined is
 * not-applicable — the counter never assumes English.
 */
export function englishLeakForArtifact(
  artifact: LeakTranscriptSource,
  opts: { locale?: string; sessionId?: string | null } = {},
): EnglishLeakCount {
  const locale = opts.locale ?? artifact.subject?.locale ?? "unknown";
  return countEnglishLeak(artifactAgentTurns(artifact, opts.sessionId), locale);
}
