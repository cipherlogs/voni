/**
 * Voice-parity ticket 77: the report-only already-answered counter.
 *
 * A reply that asks for something the caller has already answered is read from
 * the artifact's own transcript: caller (HEARD) and agent (VONI) rows in call
 * order. Three structured extractors — email address (written or spoken with
 * the Locale's own separator words), Test tag (a tag word plus two digits,
 * spoken digits included) and a four-digit code — build a ledger from caller
 * turns; an agent turn that asks for one of those categories again is a repeat.
 *
 * The counter is report-only: it never adds a gate or a sub-score, and a
 * repeating turn and a clean one produce byte-identical gate rows. Promotion is
 * a new record, added later, never an edit to this one. The English
 * false-positive rate is measured on a labelled corpus before anyone gates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildSkeletonArtifact } from "./scoreboard";
import { buildInspectReport, formatInspectReport } from "./scoreboard-report";
import {
  ENGLISH_CASES,
  type EnglishCase,
} from "./answered-question.english-cases";
import {
  ANSWERED_QUESTION_ENGLISH_FP,
  ANSWERED_QUESTION_PROMOTION,
  answeredQuestionForArtifact,
  answeredQuestionIsGating,
  countAnsweredQuestions,
  latestAnsweredQuestionPromotion,
  measureEnglishFalsePositives,
  transcriptTurnsFromTranscript,
  type AnsweredQuestionPromotion,
} from "./answered-question";

/** A Spanish call where the caller's email is asked for twice. */
const ES_REPEAT = [
  "sess_es_repeat  agent=agent_lola  18.0s  end=client_end",
  ' 1.20s  VONI    "Hola, soy Voni de WhatsApp. ¿En qué te ayudo?"  (reply_create gap 700ms)',
  ' 3.10s  HEARD   "Sí, mi correo es andres@casaverde.pt."  (3.10s–4.20s)',
  ' 5.40s  VONI    "¿Y cuál es tu etiqueta de prueba?"  (reply_create gap 800ms)',
  ' 7.60s  VONI    "Perfecto. ¿Me dices tu correo para enviarte los detalles?"  (reply_create gap 800ms)',
];

/** The same call, with the email acknowledged instead of asked for again. */
const ES_CLEAN = [
  ES_REPEAT[0]!,
  ES_REPEAT[1]!,
  ES_REPEAT[2]!,
  ES_REPEAT[3]!,
  ' 7.60s  VONI    "Perfecto, te he enviado el correo a andres@casaverde.pt."  (reply_create gap 800ms)',
];

/** A genuine clarification: the agent has the address and asks how to spell it. */
const ES_CLARIFY = [
  "sess_es_clarify  agent=agent_lola  12.0s  end=client_end",
  ES_REPEAT[2]!,
  ' 5.40s  VONI    "¿Puedes deletrear tu correo, por favor?"  (reply_create gap 800ms)',
];

/** A tag given in spoken Spanish digits, then asked for again. */
const ES_TAG = [
  "sess_es_tag  agent=agent_lola  12.0s  end=client_end",
  ' 1.20s  HEARD   "La etiqueta es Lima cuatro dos."  (1.20s–2.20s)',
  ' 3.40s  VONI    "¿Cuál era la etiqueta de prueba?"  (reply_create gap 800ms)',
];

/** A four-digit code read back, then asked for again. */
const ES_CODE = [
  "sess_es_code  agent=agent_lola  12.0s  end=client_end",
  ' 1.20s  HEARD   "Uno cero cuatro dos."  (1.20s–2.20s)',
  ' 3.40s  VONI    "¿Me lees el código de cuatro dígitos del correo?"  (reply_create gap 800ms)',
];

/** One agent request, nothing answered yet. */
const ES_ONCE = [
  "sess_es_once  agent=agent_lola  12.0s  end=client_end",
  ' 1.20s  HEARD   "Hola, tengo una panadería."  (1.20s–2.20s)',
  ' 3.40s  VONI    "¿Cuál es tu correo?"  (reply_create gap 800ms)',
];

/** One agent request in English, nothing answered yet. */
const EN_ONCE = [
  "sess_en_once  agent=agent_anna  12.0s  end=client_end",
  ' 1.20s  HEARD   "Hi, I run a bakery."  (1.20s–2.20s)',
  ' 3.40s  VONI    "What\'s your email address?"  (reply_create gap 800ms)',
];

function count(lines: string[], locale = "es") {
  return countAnsweredQuestions(
    transcriptTurnsFromTranscript(lines, lines[0]?.split(/\s+/)[0] ?? null),
    locale,
  );
}

function artifactFor(voice: string, lines: string[], runId: string) {
  return buildSkeletonArtifact({
    voice,
    scenario: "suite",
    runnerStdout: lines.join("\n"),
    exitCode: 0,
    durationMs: 1_000,
    runs: 1,
    dryRun: true,
    runId,
    traceSessionId: lines[0]?.split(/\s+/)[0] ?? null,
    traceExcerpt: lines,
  });
}

test("a reply that asks for an email the caller already gave is counted", () => {
  const repeated = count(ES_REPEAT);

  assert.equal(repeated.status, "repeated");
  assert.equal(repeated.count, 1);
  assert.equal(repeated.requests, 2, "the tag request is counted, the repeat is one of them");
  assert.ok(repeated.turns >= 3);
  assert.equal(repeated.rate, 1 / 2);
  assert.equal(repeated.reportOnly, true);
  assert.equal(repeated.findings.length, 1);

  const finding = repeated.findings[0]!;
  assert.deepEqual(finding.categories, ["email"]);
  assert.equal(finding.turn, 3, "the third VONI turn is the repeat");
  assert.equal(finding.sessionId, "sess_es_repeat");
  assert.equal(finding.answeredAt.turn, 1, "the first caller turn supplied it");
  assert.equal(finding.answeredAt.value, "andres@casaverde.pt");
  assert.match(finding.text, /Me dices tu correo/);
});

test("a legitimate follow-up is not counted: acknowledgment, first request, clarification", () => {
  const clean = count(ES_CLEAN);
  assert.equal(clean.status, "clear");
  assert.equal(clean.count, 0);
  assert.equal(clean.requests, 1, "the tag request is still a request");
  assert.equal(clean.rate, 0);

  const clarified = count(ES_CLARIFY);
  assert.equal(clarified.count, 0, "asking how to spell an address is a clarification");
  assert.equal(
    clarified.requests,
    0,
    "a clarification is not a request for the value",
  );
  assert.equal(clarified.rate, null);
});

test("an agent that asks once is not counted", () => {
  const once = count(ES_ONCE);
  assert.equal(once.status, "clear");
  assert.equal(once.count, 0);
  assert.equal(once.requests, 1);
  assert.equal(once.rate, 0);
});

test("spoken values are read with the Locale's own words: tag and code", () => {
  const tag = count(ES_TAG);
  assert.equal(tag.count, 1);
  assert.deepEqual(tag.findings[0]!.categories, ["tag"]);
  assert.equal(tag.findings[0]!.answeredAt.value, "lima 42");

  const code = count(ES_CODE);
  assert.equal(code.count, 1);
  assert.deepEqual(code.findings[0]!.categories, ["code"]);
  assert.equal(code.findings[0]!.answeredAt.value, "1042");
});

test("only an earlier answer counts, and a session is its own call", () => {
  // Asked, then answered, then asked again: the first ask is not a repeat.
  const askedThenAnswered = count([
    "sess_es_order  agent=agent_lola  12.0s  end=client_end",
    ' 1.20s  VONI    "¿Cuál es tu correo?"  (reply_create gap 800ms)',
    ' 3.40s  HEARD   "andres@casaverde.pt"  (3.40s–4.40s)',
    ' 5.60s  VONI    "¿Me lo repites?"  (reply_create gap 800ms)',
  ]);
  assert.equal(askedThenAnswered.count, 0, "a repeat clarification is exempt");
  assert.equal(askedThenAnswered.requests, 1);

  const askedAnsweredAsked = count([
    "sess_es_order  agent=agent_lola  12.0s  end=client_end",
    ' 1.20s  VONI    "¿Cuál es tu correo?"  (reply_create gap 800ms)',
    ' 3.40s  HEARD   "andres@casaverde.pt"  (3.40s–4.40s)',
    ' 5.60s  VONI    "¿Y tu correo, cuál es?"  (reply_create gap 800ms)',
  ]);
  assert.equal(askedAnsweredAsked.count, 1);
  assert.equal(askedAnsweredAsked.findings[0]!.turn, 2);

  // An answer in one session never satisfies a request in the next.
  const twoSessions = count([
    "sess_es_one  agent=agent_lola  12.0s  end=client_end",
    ' 1.20s  HEARD   "andres@casaverde.pt"  (1.20s–2.20s)',
    "sess_es_two  agent=agent_lola  9.0s  end=client_end",
    ' 1.20s  VONI    "¿Cuál es tu correo?"  (reply_create gap 800ms)',
  ]);
  assert.equal(twoSessions.status, "clear");
  assert.equal(twoSessions.count, 0);
  assert.equal(twoSessions.requests, 1);
});

test("the counter reports unmeasured and not-applicable instead of a clean zero", () => {
  const empty = countAnsweredQuestions(
    transcriptTurnsFromTranscript([], null),
    "es",
  );
  assert.equal(empty.status, "unmeasured");
  assert.equal(empty.count, 0);
  assert.equal(empty.turns, 0);
  assert.equal(empty.requests, 0);
  assert.equal(empty.rate, null);

  const unknown = count(ES_REPEAT, "unknown");
  assert.equal(unknown.status, "not-applicable");
  assert.equal(unknown.applicable, false);
  assert.equal(unknown.count, 0);
  assert.equal(unknown.rate, null);
});

test("the English false-positive rate is measured on the labelled corpus before gating", () => {
  const measured = measureEnglishFalsePositives(ENGLISH_CASES);

  assert.equal(measured.cases, 17);
  assert.equal(measured.flagged, 6, "six repeated questions are caught");
  assert.equal(measured.falsePositives, 0, "no clarification or acknowledgment is flagged");
  assert.equal(measured.missed, 1, "the paraphrase case is a miss, recorded not hidden");
  assert.equal(measured.falsePositiveRate, 0);

  assert.deepEqual(
    {
      cases: ANSWERED_QUESTION_ENGLISH_FP.cases,
      flagged: ANSWERED_QUESTION_ENGLISH_FP.flagged,
      falsePositives: ANSWERED_QUESTION_ENGLISH_FP.falsePositives,
      missed: ANSWERED_QUESTION_ENGLISH_FP.missed,
      falsePositiveRate: ANSWERED_QUESTION_ENGLISH_FP.falsePositiveRate,
    },
    measured,
    "the record in the artifact is the measurement, not a hand-typed number",
  );
  assert.ok(Object.isFrozen(ANSWERED_QUESTION_ENGLISH_FP));
  assert.match(ANSWERED_QUESTION_ENGLISH_FP.source, /labelled English corpus/);
});

test("the false-positive measurement can fail: a mislabelled clarification is a false positive", () => {
  const wrong: EnglishCase[] = [
    {
      label: "clarification",
      note: "deliberately mislabelled: this is a repeat",
      transcript: [
        "sess_en_wrong  agent=agent_anna  12.0s  end=client_end",
        ' 1.20s  HEARD   "andres@casaverde.pt"  (1.20s–2.20s)',
        ' 3.40s  VONI    "What is your email?"  (reply_create gap 800ms)',
      ],
    },
  ];
  const measured = measureEnglishFalsePositives(wrong);
  assert.equal(measured.flagged, 1);
  assert.equal(measured.falsePositives, 1);
  assert.equal(measured.falsePositiveRate, 1);
});

test("the artifact records the count and the promotion decision", () => {
  const repeated = artifactFor("lola", ES_REPEAT, "run-es-repeat");

  assert.ok(repeated.answeredQuestion, "the artifact carries the counter");
  assert.equal(repeated.answeredQuestion.count, 1);
  assert.equal(repeated.answeredQuestion.requests, 2);
  assert.equal(repeated.answeredQuestion.locale, "es");
  assert.equal(repeated.answeredQuestion.reportOnly, true);
  assert.deepEqual(repeated.answeredQuestion.promotion, ANSWERED_QUESTION_PROMOTION);
  assert.equal(repeated.answeredQuestion.promotion.gating, false);

  const clean = artifactFor("lola", ES_CLEAN, "run-es-clean");
  assert.equal(clean.answeredQuestion?.count, 0);
  assert.equal(clean.answeredQuestion?.status, "clear");

  // A stored artifact read back from disk re-derives the same counter.
  const fromArtifact = answeredQuestionForArtifact(
    JSON.parse(JSON.stringify(repeated)),
  );
  assert.equal(fromArtifact.count, 1);
  assert.equal(fromArtifact.requests, 2);
});

test("a redacted transcript still counts the answer, and the value stays redacted", () => {
  // No Call trace: the artifact's own transcript is redacted, so the caller's
  // address is the `[email]` placeholder. The category is still structured
  // evidence, and the value never leaves the transcript's redaction.
  const redacted = buildSkeletonArtifact({
    voice: "lola",
    scenario: "suite",
    runnerStdout: ES_REPEAT.join("\n"),
    exitCode: 0,
    durationMs: 1_000,
    runs: 1,
    dryRun: true,
    runId: "run-es-redacted",
  });
  assert.equal(redacted.answeredQuestion?.count, 1);
  assert.equal(redacted.answeredQuestion?.findings[0]?.answeredAt.value, "[email]");
  assert.equal(
    redacted.answeredQuestion?.findings[0]?.answeredAt.turn,
    1,
    "the caller turn pointer survives redaction",
  );
});

test("the counter is report-only: a repeating turn and a clean one have identical gates", () => {
  const repeated = artifactFor("lola", ES_REPEAT, "run-es-repeat");
  const clean = artifactFor("lola", ES_CLEAN, "run-es-clean");

  assert.deepEqual(repeated.gates, clean.gates);
  assert.deepEqual(repeated.subScores, clean.subScores);
  assert.deepEqual(repeated.beats, clean.beats);
  assert.deepEqual(repeated.replyGap, clean.replyGap);

  const names = [
    ...repeated.gates.map((gate) => gate.name),
    ...repeated.subScores.map((sub) => sub.name),
  ];
  assert.ok(!names.some((name) => /answered|repeat/i.test(name)));
});

test("the compact report exposes the repeated question and the English baseline", () => {
  const spanish = buildInspectReport(
    artifactFor("lola", ES_REPEAT, "run-es-repeat"),
  );
  assert.equal(spanish.answeredQuestion.count, 1);
  assert.equal(spanish.answeredQuestion.rate, 1 / 2);
  const text = formatInspectReport(spanish);
  assert.match(text, /answered-question \(report-only, never gated\)/);
  assert.match(text, /1 of 2 requests repeat an answer \(0\.50\)/);
  assert.match(
    text,
    /repeated\s+sess_es_repeat turn 3: email already answered at turn 1 \(andres@casaverde\.pt\)/,
  );
  assert.match(text, /promotion\s+report-only \(never gated\)/);

  const english = buildInspectReport(
    artifactFor("anna", EN_ONCE, "run-en-baseline"),
  );
  const englishText = formatInspectReport(english);
  assert.match(englishText, /english-fp\s+0\.00 over 17 labelled cases \(0 false positives of 6 flagged, 1 missed\)/);
  assert.match(englishText, /baseline\s+this run 0 of 1 requests flagged \(0\.00\)/);
});

test("promotion is a new record added later, never an edit to the report-only one", () => {
  assert.deepEqual(ANSWERED_QUESTION_PROMOTION, {
    gating: false,
    decidedAt: null,
    source:
      "voice-parity 77: report-only until the English false-positive rate is known; " +
      "promotion adds a new record beside this one and is never an edit of it",
  });
  assert.ok(Object.isFrozen(ANSWERED_QUESTION_PROMOTION));
  assert.equal(answeredQuestionIsGating(), false);

  const promoted: AnsweredQuestionPromotion = {
    gating: true,
    decidedAt: "2026-11-01",
    source: "owner sign-off: English FP 0.00 over N live runs",
  };
  const active = latestAnsweredQuestionPromotion([
    ANSWERED_QUESTION_PROMOTION,
    promoted,
  ]);
  assert.equal(active.gating, true);
  assert.equal(
    ANSWERED_QUESTION_PROMOTION.gating,
    false,
    "the original record is untouched",
  );
});
