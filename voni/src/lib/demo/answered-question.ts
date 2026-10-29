/**
 * Voice-parity ticket 77: the already-answered question counter (spec W5).
 *
 * A reply that asks for something the caller has already answered is the
 * "ask again" defect the owner hears beside the mishearing half of the problem:
 * the caller says the address, and two turns later the agent asks for the
 * address again. This module counts those replies from the artifact's own
 * transcript and nothing else: no audio, no model, no clock.
 *
 * Report-only, by design. The counter sits beside the ratings as evidence; it
 * adds no gate, no sub-score and never moves a PASS/FAIL. It stays report-only
 * until its false-positive rate on English is known, and even then the
 * promotion is a *new* record (see `ANSWERED_QUESTION_PROMOTION`), never an
 * edit to the record that shipped report-only. The rate is measured on a
 * hand-labelled English corpus (`ANSWERED_QUESTION_ENGLISH_FP`), so a gate
 * decision starts from a number rather than an impression.
 *
 * The detection rule, stated so a reader can argue with it:
 *
 * 1. Read the merged Call trace in order — `HEARD` rows are caller turns,
 *    `VONI` rows are agent turns — one session at a time. A ledger is built
 *    from caller turns only, by three structured extractors:
 *    - an email address, written (`andres@casaverde.pt`) or spoken with the
 *      Locale's own separator words (`andres at casaverde dot pt`);
 *    - a Test tag: a `TAG_WORDS` word followed by exactly two digits, with the
 *      Locale's spoken digit words resolved first (`Lima cuatro dos`);
 *    - a four-digit code, only when the caller names the code or says nothing
 *      but the number (`One zero four two`).
 * 2. An agent turn is a *request* when it carries a question mark or one of the
 *    Locale's request phrases, names at least one of those categories with the
 *    Locale's own cue words, and carries no clarification phrase — spelling,
 *    a missed-hearing, a check of what was heard. A confirmation ("just to
 *    confirm, the tag is Lime 42") is a clarification, not a request.
 * 3. A request is *repeated* when the same session's caller ledger already
 *    holds that category from an earlier caller turn. An answer never crosses
 *    a session boundary, and an answer that arrives after the question does not
 *    satisfy it.
 * 4. Everything else is not counted. There is no fuzzy matching and no
 *    semantic inference: three closed lexicons (categories, request,
 *    clarification) and three structured extractors.
 *
 * Known limitations, recorded rather than hidden (each one under-counts, which
 * is the direction a report-only counter should fail in):
 * - A paraphrase that never names the category ("where should I send the
 *   invoice?") is missed; the English corpus carries one, labelled `paraphrase`.
 * - A confirmation is exempt, so an agent that re-confirms a value it was just
 *   given is not counted.
 * - A caller turn that names the code or is only the number is a code; a year
 *   or a price the caller mentioned in passing is not.
 * - A turn that clarifies one category and re-asks another is exempt for both.
 */
import {
  callRecognition,
  isRecognitionLocale,
  spokenDigitsToNumerals,
  type CompleteRecognition,
} from "@/lib/voice/recognition";
import { TAG_WORDS } from "./test-tag";
import { ENGLISH_CASES, type EnglishCase } from "./answered-question.english-cases";

/**
 * The promotion decision (voice-parity 77). Report-only: this record can never
 * gate. Promotion is a NEW record appended to `ANSWERED_QUESTION_PROMOTIONS` —
 * carrying the measured English false-positive rate and a stated source — and
 * this record is never edited.
 */
export type AnsweredQuestionPromotion = {
  readonly gating: boolean;
  /** ISO date the decision was made; null while report-only. */
  readonly decidedAt: string | null;
  /** Why the decision was made, in one line a reader can audit. */
  readonly source: string;
};

/**
 * The record that shipped with ticket 77. Frozen: promotion appends a sibling
 * record to `ANSWERED_QUESTION_PROMOTIONS` instead of changing this one.
 */
export const ANSWERED_QUESTION_PROMOTION: AnsweredQuestionPromotion =
  Object.freeze({
    gating: false,
    decidedAt: null,
    source:
      "voice-parity 77: report-only until the English false-positive rate is known; " +
      "promotion adds a new record beside this one and is never an edit of it",
  });

/** Every promotion record, oldest first. A promotion appends; it never edits. */
export const ANSWERED_QUESTION_PROMOTIONS: readonly AnsweredQuestionPromotion[] =
  Object.freeze([ANSWERED_QUESTION_PROMOTION]);

/** The record in force: the last one appended. */
export function latestAnsweredQuestionPromotion(
  records: readonly AnsweredQuestionPromotion[] = ANSWERED_QUESTION_PROMOTIONS,
): AnsweredQuestionPromotion {
  const active = records[records.length - 1];
  if (!active) throw new Error("no answered-question promotion record exists");
  return active;
}

/** Whether the counter is gating yet. Always false until a new record lands. */
export function answeredQuestionIsGating(): boolean {
  return latestAnsweredQuestionPromotion().gating;
}

/** The value kinds the counter extracts without guessing. */
export type AnswerCategory = "email" | "tag" | "code";

/** Report order; also the order a finding lists its categories in. */
export const ANSWER_CATEGORIES: readonly AnswerCategory[] = [
  "email",
  "tag",
  "code",
];

/** How a category reads in the compact report. */
export function formatAnswerCategory(category: AnswerCategory): string {
  return category === "tag" ? "test tag" : category;
}

/** One structured value a caller supplied. */
export type CallerAnswer = {
  category: AnswerCategory;
  /** The value as it can be quoted back: lowercased address, folded tag or code. */
  value: string;
};

/** A value plus the caller turn it came from. */
export type CallerAnswerAt = CallerAnswer & {
  sessionId: string | null;
  /** 1-based `HEARD` ordinal in that session. */
  turn: number;
};

/** One ordered Call trace row: a caller turn or an agent turn. */
export type TraceTurn = {
  sessionId: string | null;
  role: "caller" | "agent";
  /** 1-based ordinal in the session for that role, as the Call trace numbers its rows. */
  turn: number;
  text: string;
};

/** One agent turn that asked for a value the caller had already supplied. */
export type AnsweredQuestionFinding = {
  sessionId: string | null;
  /** The repeating agent turn (1-based `VONI` ordinal in its session). */
  turn: number | null;
  /** Every category the turn asked for that was already answered. */
  categories: AnswerCategory[];
  /** The latest caller turn that supplied the first repeated category. */
  answeredAt: CallerAnswerAt;
  /** The agent turn's own words (caller words never reach this counter as text). */
  text: string;
};

export type AnsweredQuestionStatus =
  | "clear"
  | "repeated"
  | "unmeasured"
  | "not-applicable";

/**
 * One subject's English false-positive measurement. `falsePositiveRate` is
 * `falsePositives / cases`: a case the counter flagged whose human label is not
 * `repeated` is a false positive; a `repeated` or `paraphrase` case the counter
 * missed lowers coverage, never the false-positive rate.
 */
export type EnglishFalsePositiveMeasurement = {
  cases: number;
  flagged: number;
  falsePositives: number;
  missed: number;
  falsePositiveRate: number | null;
};

/** The measured record, with the provenance a promotion decision cites. */
export type AnsweredQuestionEnglishFp = EnglishFalsePositiveMeasurement & {
  /** ISO date the corpus was last measured. */
  measuredAt: string;
  source: string;
};

/**
 * Measure the counter on the labelled English corpus. Pure: the corpus is data,
 * so the number in the record is the measurement and cannot drift from it.
 */
export function measureEnglishFalsePositives(
  cases: readonly EnglishCase[],
): EnglishFalsePositiveMeasurement {
  let flagged = 0;
  let falsePositives = 0;
  let missed = 0;
  for (const testCase of cases) {
    const count = countAnsweredQuestions(
      transcriptTurnsFromTranscript(testCase.transcript, null),
      "en",
    );
    const fired = count.findings.length > 0;
    if (fired) flagged += 1;
    if (fired && testCase.label !== "repeated") falsePositives += 1;
    if (!fired && testCase.label !== "clarification" && testCase.label !== "not-a-request") {
      missed += 1;
    }
  }
  return {
    cases: cases.length,
    flagged,
    falsePositives,
    missed,
    falsePositiveRate: cases.length === 0 ? null : falsePositives / cases.length,
  };
}

/**
 * One English run's own exposure: how many of its requests were flagged. It is
 * a raw rate, not a false-positive rate — the run's labels are the counter's
 * own. The false-positive rate is the measured corpus record above.
 */
export type AnsweredQuestionEnglishBaseline = {
  turns: number;
  requests: number;
  flagged: number;
  /** flagged / requests; null when the run asked for nothing. */
  rate: number | null;
};

/**
 * One subject's already-answered evidence. `reportOnly` and `promotion` travel
 * with the count so no reader — artifact, report or gate — can mistake it for a
 * verdict. `requests` is the rate's denominator: agent turns that asked for a
 * structured value, whether or not it had been answered.
 */
export type AnsweredQuestionCount = {
  status: AnsweredQuestionStatus;
  /** False for a Locale with no cue lexicon: the counter never assumes English. */
  applicable: boolean;
  locale: string;
  /** Agent turns that asked for an already-answered value. */
  count: number;
  /** Agent turns that asked for a structured value at all. */
  requests: number;
  /** Agent turns examined. */
  turns: number;
  /** count / requests; null when nothing was asked or the counter does not apply. */
  rate: number | null;
  findings: AnsweredQuestionFinding[];
  reportOnly: true;
  promotion: AnsweredQuestionPromotion;
  /** Non-null on an English subject: this run's own flagged-request rate. */
  englishBaseline: AnsweredQuestionEnglishBaseline | null;
};

/** Lowercased, accent-free, punctuation-free words with single spaces. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Folded phrases, cached per cue list: a cue is a whole phrase, never a substring. */
const foldedPhrases = new WeakMap<readonly string[], readonly string[]>();

function phrasings(phrases: readonly string[]): readonly string[] {
  const cached = foldedPhrases.get(phrases);
  if (cached) return cached;
  const folded = phrases.map(fold).filter((phrase) => phrase.length > 0);
  foldedPhrases.set(phrases, folded);
  return folded;
}

/** Whether folded text carries one of the phrases as whole words. */
function says(foldedText: string, phrases: readonly string[]): boolean {
  const haystack = ` ${foldedText} `;
  return phrasings(phrases).some((phrase) => haystack.includes(` ${phrase} `));
}

/**
 * The closed lexicons per Locale: what the agent calls a value, what makes a
 * turn a request, and what makes it a clarification (checking the form of a
 * value it already has rather than asking for the value).
 */
type AnswerCues = {
  category: Record<AnswerCategory, readonly string[]>;
  request: readonly string[];
  clarification: readonly string[];
};

const ANSWER_CUES: Readonly<Record<string, AnswerCues>> = {
  en: {
    category: {
      email: ["email", "e-mail", "mail", "address", "inbox"],
      tag: ["tag", "test tag", "subject"],
      code: ["code", "four digit code", "four digits", "digit"],
    },
    request: [
      "tell me", "give me", "send me", "share", "let me know", "i need",
      "i'll need", "still need", "remind me", "can you", "could you", "would you",
      "what", "what is", "what's", "what was", "which", "please",
    ],
    clarification: [
      "spell", "didn't catch", "didn't get", "didn't hear", "not sure i heard",
      "was that", "did you say", "is that right", "is that correct",
      "just to confirm", "confirm", "read it back", "slower", "louder",
      "clarify", "just to check",
    ],
  },
  es: {
    category: {
      email: ["correo", "email", "e-mail", "dirección", "buzón"],
      tag: ["etiqueta", "tag", "asunto"],
      code: ["código", "cuatro dígitos", "dígitos", "cifra"],
    },
    request: [
      "dime", "dame", "comparte", "necesito", "puedes", "podrías",
      "me dices", "me das", "me lees", "cuál es", "cuál era", "por favor",
      "recuérdame", "me confirmas", "aún necesito", "cuál",
    ],
    clarification: [
      "deletrea", "deletrear", "cómo se escribe", "no te he oído",
      "no lo he oído", "no te escuché", "has dicho", "es correcto",
      "correcto", "confirma", "confirmas", "más despacio", "más alto",
      "aclárame", "solo para confirmar",
    ],
  },
  fr: {
    category: {
      email: ["courriel", "email", "e-mail", "adresse", "boîte"],
      tag: ["étiquette", "tag", "objet"],
      code: ["code", "quatre chiffres", "chiffres"],
    },
    request: [
      "dites-moi", "donnez-moi", "j'ai besoin", "pouvez-vous", "pourriez-vous",
      "quel est", "quelle est", "s'il vous plaît", "rappelez-moi", "il me faut",
    ],
    clarification: [
      "épeler", "comment s'écrit", "je n'ai pas entendu", "vous avez dit",
      "c'est correct", "confirmer", "confirmez", "plus lentement", "plus fort",
    ],
  },
  de: {
    category: {
      email: ["e-mail", "email", "mail", "adresse", "postfach"],
      tag: ["etikett", "tag", "betreff"],
      code: ["code", "vier ziffern", "ziffern"],
    },
    request: [
      "sagen sie mir", "geben sie mir", "ich brauche", "können sie",
      "welche", "wie lautet", "bitte", "noch einmal",
    ],
    clarification: [
      "buchstabieren", "nicht verstanden", "haben sie gesagt",
      "ist das richtig", "bestätigen", "bestätige", "langsamer", "lauter",
    ],
  },
  it: {
    category: {
      email: ["email", "e-mail", "indirizzo", "mail", "casella"],
      tag: ["etichetta", "tag", "oggetto"],
      code: ["codice", "quattro cifre", "cifre"],
    },
    request: [
      "dimmi", "dammi", "ho bisogno", "puoi", "potresti", "qual è",
      "qual era", "per favore", "ricordami", "mi serve",
    ],
    clarification: [
      "come si scrive", "non ho sentito", "hai detto", "è corretto",
      "confermi", "conferma", "più lentamente", "più forte",
    ],
  },
  pt: {
    category: {
      email: ["email", "e-mail", "endereço", "mail", "caixa"],
      tag: ["etiqueta", "tag", "assunto"],
      code: ["código", "quatro dígitos", "dígitos"],
    },
    request: [
      "diga-me", "me diga", "me dá", "preciso", "você pode", "pode",
      "qual é", "qual era", "por favor", "lembre-me", "ainda preciso",
    ],
    clarification: [
      "soletrar", "como se escreve", "não ouvi", "você disse",
      "está correto", "confirma", "confirme", "mais devagar", "mais alto",
    ],
  },
};

const EMAIL_WRITTEN = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const EMAIL_EXACT = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const TAG_WORD_SHAPE = /^[a-z0-9]+(?:[._%+-][a-z0-9]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9-]+$/;

/** Every Test-tag word, in every Locale, folded: a tag is `<word> <two digits>`. */
const TAG_WORDS_FOLDED: ReadonlySet<string> = new Set(
  Object.values(TAG_WORDS)
    .flat()
    .map(fold),
);

/** The redaction placeholder the artifact's own transcript keeps for an address. */
const EMAIL_PLACEHOLDER = /\[email\]/gi;

/** Email addresses the caller wrote out. */
function writtenEmails(text: string): string[] {
  return [
    ...[...text.matchAll(EMAIL_WRITTEN)].map((match) => match[0].toLowerCase()),
    // The artifact's own transcript is redacted; the placeholder still proves
    // the caller supplied an address, and it stays redacted on the way out.
    ...[...text.matchAll(EMAIL_PLACEHOLDER)].map(() => "[email]"),
  ];
}

/**
 * Email addresses the caller spelled out loud, using this Locale's own
 * separator words (`andres at casaverde dot pt`). The grammar is deliberate: a
 * local word, an "at", a label, at least one "dot" and a label. A word after the
 * last label stops the address instead of being absorbed into it.
 */
function spokenEmails(
  text: string,
  recognition: CompleteRecognition,
): string[] {
  const tokens = fold(text).split(" ").filter(Boolean);
  const separators = (forms: readonly string[]) =>
    new Set(forms.map(fold).filter(Boolean));
  const at = separators(recognition.address.at);
  const dot = separators(recognition.address.dot);
  const found: string[] = [];
  for (let index = 1; index < tokens.length - 2; index += 1) {
    if (!at.has(tokens[index]!)) continue;
    const local = tokens[index - 1]!;
    if (!TAG_WORD_SHAPE.test(local)) continue;
    const first = tokens[index + 1]!;
    if (!DOMAIN_LABEL.test(first)) continue;
    const labels = [first];
    let cursor = index + 2;
    while (
      cursor + 1 < tokens.length &&
      dot.has(tokens[cursor]!) &&
      DOMAIN_LABEL.test(tokens[cursor + 1]!)
    ) {
      labels.push(tokens[cursor + 1]!);
      cursor += 2;
    }
    if (labels.length < 2) continue;
    const address = `${local}@${labels.join(".")}`;
    if (EMAIL_EXACT.test(address) && !found.includes(address)) found.push(address);
    index = cursor - 1;
  }
  return found;
}

/**
 * Test tags in a caller turn: the Locale's spoken digit words are resolved
 * first, then a tag word must sit directly before exactly two digits.
 */
function tagsIn(text: string, recognition: CompleteRecognition): string[] {
  const numerals = joinLoneDigitPair(
    fold(spokenDigitsToNumerals(text, recognition)),
  );
  const found: string[] = [];
  for (const match of numerals.matchAll(/([\p{L}]+) (\d{2})(?!\d)/gu)) {
    const word = match[1]!;
    if (!TAG_WORDS_FOLDED.has(word)) continue;
    const tag = `${word} ${match[2]!}`;
    if (!found.includes(tag)) found.push(tag);
  }
  return found;
}

/** "Lima 4 2" — a digit pair read one at a time — is the tag "42". */
function joinLoneDigitPair(text: string): string {
  return text.replace(/(^|\D)(\d) (\d)(?!\d)/g, "$1$2$3");
}

/**
 * A four-digit code, only when the caller names the code (`my code is 1042`)
 * or says nothing but the number (`One zero four two`). A year or a price
 * mentioned in passing is not a code the agent can ask for again.
 */
function codesIn(
  text: string,
  recognition: CompleteRecognition,
  cues: AnswerCues,
): string[] {
  const numerals = fold(spokenDigitsToNumerals(text, recognition));
  const onlyDigits = numerals.replace(/\s+/g, "");
  const named = says(numerals, cues.category.code);
  if (!named && !/^\d{4}$/.test(onlyDigits)) return [];
  const found: string[] = [];
  for (const match of numerals.matchAll(/(?:^|\D)(\d{4})(?!\d)/g)) {
    const code = match[1]!;
    if (!found.includes(code)) found.push(code);
  }
  return found;
}

/** Every structured value a caller turn supplies, in category order. */
function callerAnswersIn(
  text: string,
  recognition: CompleteRecognition,
  cues: AnswerCues,
): CallerAnswer[] {
  const answers: CallerAnswer[] = [];
  for (const value of writtenEmails(text)) answers.push({ category: "email", value });
  for (const value of spokenEmails(text, recognition)) {
    if (!answers.some((answer) => answer.value === value)) {
      answers.push({ category: "email", value });
    }
  }
  for (const value of tagsIn(text, recognition)) answers.push({ category: "tag", value });
  for (const value of codesIn(text, recognition, cues)) {
    answers.push({ category: "code", value });
  }
  return answers;
}

/**
 * The categories an agent turn asks for: it must be a request (a question mark
 * or one of the Locale's request phrases), must not be a clarification, and
 * must name the category with the Locale's own cue words.
 */
function requestedCategories(
  text: string,
  cues: AnswerCues,
): AnswerCategory[] {
  const folded = fold(text);
  if (says(folded, cues.clarification)) return [];
  const asks = text.includes("?") || says(folded, cues.request);
  if (!asks) return [];
  return ANSWER_CATEGORIES.filter((category) => says(folded, cues.category[category]));
}

/** The Locale's recognition and cue set, or null when the Locale has neither. */
function lexiconFor(
  locale: string,
): { recognition: CompleteRecognition; cues: AnswerCues } | null {
  if (!isRecognitionLocale(locale)) return null;
  const cues = ANSWER_CUES[locale];
  if (!cues) return null;
  return { recognition: callRecognition({ conversationLanguage: locale }), cues };
}

const SESSION_HEADER = /^\s*(sess_[A-Za-z0-9_-]+)\b/;
const TRACE_ROW = /^\s*\d+(?:\.\d+)?s\s+(VONI|HEARD)\s+"([^"]*)"/;

/**
 * Caller and agent turns as the merged Call trace printed them, in order:
 * `HEARD "…"` is a caller turn, `VONI "…"` an agent turn, numbered per role
 * within their session. A session header (`sess_…  agent=…`) names the call the
 * rows after it belong to; without one the turns stay unattributed (null),
 * never guessed onto another session.
 */
export function transcriptTurnsFromTranscript(
  lines: readonly string[],
  sessionId: string | null = null,
): TraceTurn[] {
  const turns: TraceTurn[] = [];
  let currentSession = sessionId;
  let callerTurn = 0;
  let agentTurn = 0;
  for (const line of lines) {
    const header = SESSION_HEADER.exec(line);
    if (header) {
      if (header[1] !== currentSession) {
        callerTurn = 0;
        agentTurn = 0;
      }
      currentSession = header[1] ?? currentSession;
      continue;
    }
    const row = TRACE_ROW.exec(line);
    if (!row) continue;
    if (row[1] === "HEARD") {
      callerTurn += 1;
      turns.push({
        sessionId: currentSession,
        role: "caller",
        turn: callerTurn,
        text: row[2] ?? "",
      });
    } else {
      agentTurn += 1;
      turns.push({
        sessionId: currentSession,
        role: "agent",
        turn: agentTurn,
        text: row[2] ?? "",
      });
    }
  }
  return turns;
}

/**
 * Count the agent turns that ask for a value the caller already supplied. A
 * transcript with no agent turn is unmeasured (rate null), never a clean zero;
 * a Locale with no cue lexicon is not-applicable, never scanned with English's
 * words.
 */
export function countAnsweredQuestions(
  turns: readonly TraceTurn[],
  locale: string,
): AnsweredQuestionCount {
  const lexicon = lexiconFor(locale);
  const findings: AnsweredQuestionFinding[] = [];
  let agentTurns = 0;
  let requests = 0;
  let session: string | null | undefined;
  let ledger = new Map<AnswerCategory, CallerAnswerAt>();
  for (const turn of turns) {
    if (turn.sessionId !== session) {
      session = turn.sessionId;
      ledger = new Map();
    }
    if (turn.role === "caller") {
      if (!lexicon) continue;
      for (const answer of callerAnswersIn(turn.text, lexicon.recognition, lexicon.cues)) {
        ledger.set(answer.category, {
          ...answer,
          sessionId: turn.sessionId,
          turn: turn.turn,
        });
      }
      continue;
    }
    agentTurns += 1;
    if (!lexicon) continue;
    const asked = requestedCategories(turn.text, lexicon.cues);
    if (asked.length === 0) continue;
    requests += 1;
    const repeated = asked.filter((category) => ledger.has(category));
    if (repeated.length === 0) continue;
    const answeredAt = ledger.get(repeated[0]!)!;
    findings.push({
      sessionId: turn.sessionId,
      turn: turn.turn,
      categories: repeated,
      answeredAt,
      text: turn.text,
    });
  }
  const rate =
    lexicon && requests > 0 ? findings.length / requests : null;
  const status: AnsweredQuestionStatus = !lexicon
    ? "not-applicable"
    : agentTurns === 0
      ? "unmeasured"
      : findings.length > 0
        ? "repeated"
        : "clear";
  return {
    status,
    applicable: lexicon !== null,
    locale,
    count: findings.length,
    requests,
    turns: agentTurns,
    rate,
    findings,
    reportOnly: true,
    promotion: latestAnsweredQuestionPromotion(),
    englishBaseline:
      locale === "en"
        ? {
            turns: agentTurns,
            requests,
            flagged: findings.length,
            rate,
          }
        : null,
  };
}

/**
 * The measured English false-positive record. Derived from the labelled corpus
 * at load, so the number in an artifact is the measurement and cannot drift
 * from the cases that produced it.
 */
export const ANSWERED_QUESTION_ENGLISH_FP: AnsweredQuestionEnglishFp =
  Object.freeze({
    ...measureEnglishFalsePositives(ENGLISH_CASES),
    measuredAt: "2026-10-29",
    source:
      "measured on the labelled English corpus in answered-question.english-cases.ts " +
      "(17 hand-labelled Call trace fixtures); fixture evidence, not a live-call measurement",
  });

/** The transcript-shaped slice of an artifact this counter reads. */
export type AnsweredTranscriptSource = {
  readonly voice?: string;
  readonly subject?: { readonly locale: string } | null;
  readonly transcripts?: { readonly redacted: readonly string[] } | null;
  readonly callTrace?: {
    readonly sessionId?: string | null;
    readonly excerpt: readonly string[];
    readonly sessions?: readonly {
      readonly sessionId: string | null;
      readonly excerpt: readonly string[];
    }[];
  } | null;
};

/** Every caller and agent turn the artifact's transcript carries, in order. */
function artifactTurns(
  artifact: AnsweredTranscriptSource,
  sessionId: string | null | undefined,
): TraceTurn[] {
  const trace = artifact.callTrace;
  const traceSessions =
    trace?.sessions && trace.sessions.length > 0
      ? trace.sessions.map((session) => ({
          sessionId: session.sessionId,
          lines: session.excerpt,
        }))
      : trace
        ? [{ sessionId: trace.sessionId ?? null, lines: trace.excerpt }]
        : [];
  const fromTrace = traceSessions.flatMap((session) =>
    transcriptTurnsFromTranscript(session.lines, session.sessionId),
  );
  const turns =
    fromTrace.length > 0
      ? fromTrace
      : transcriptTurnsFromTranscript(artifact.transcripts?.redacted ?? [], null);
  return sessionId
    ? turns.filter((turn) => turn.sessionId === sessionId)
    : turns;
}

/**
 * The counter for one artifact, read from its transcript. The Locale comes from
 * the artifact's subject; a caller may pass the resolved Locale (the compact
 * report does, so a legacy artifact derives it from its voice) and a session to
 * narrow the reading. An artifact whose Locale is undetermined is
 * not-applicable — the counter never assumes English's cue words.
 */
export function answeredQuestionForArtifact(
  artifact: AnsweredTranscriptSource,
  opts: { locale?: string; sessionId?: string | null } = {},
): AnsweredQuestionCount {
  const locale = opts.locale ?? artifact.subject?.locale ?? "unknown";
  return countAnsweredQuestions(artifactTurns(artifact, opts.sessionId), locale);
}
