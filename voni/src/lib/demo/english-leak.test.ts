/**
 * Voice-parity ticket 76: the report-only English-leak counter.
 *
 * A non-English reply that leaks English words is read from the artifact's
 * own transcript (the merged Call trace's `VONI` rows). Genuine proper nouns
 * and the Locale's own words are exempt; a Locale that is not spoken (or has
 * no Locale at all) is never scanned, and English is never scanned at all —
 * its turns are the baseline the false-positive rate is measured on.
 *
 * The counter is report-only: it never adds a gate or a sub-score and a
 * leaking turn and a clean one produce byte-identical gate rows. Promotion is
 * a new record, added later, never an edit to this one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildSkeletonArtifact } from "./scoreboard";
import { buildInspectReport, formatInspectReport } from "./scoreboard-report";
import {
  agentTurnsFromTranscript,
  countEnglishLeak,
  ENGLISH_LEAK_PROMOTION,
  englishLeakForArtifact,
  englishLeakIsGating,
  latestEnglishLeakPromotion,
  type EnglishLeakPromotion,
} from "./english-leak";
import { SubjectError } from "./subject";

/** A Spanish call: the greeting and two clean replies. */
const ES_CLEAN = [
  "sess_es_clean  agent=agent_lola  18.0s  end=client_end",
  ' 1.20s  VONI    "Hola, soy Voni de WhatsApp. ¿En qué te ayudo?"  (reply_create gap 700ms)',
  ' 4.50s  VONI    "Claro, te envío el enlace por WhatsApp ahora mismo."  (reply_create gap 800ms)',
  ' 7.10s  VONI    "Perfecto, hablamos pronto. ¡Hasta luego!"  (reply_create gap 900ms)',
];

/** The same call with one reply that leaks four English words. */
const ES_LEAK = [
  ES_CLEAN[0]!,
  ES_CLEAN[1]!,
  ' 4.50s  VONI    "Claro, I can send you the email right now."  (reply_create gap 800ms)',
  ES_CLEAN[3]!,
];

/** An English call: three English replies and one proper-noun-only reply. */
const EN_BASELINE = [
  "sess_en_base  agent=agent_anna  21.0s  end=client_end",
  ' 1.10s  VONI    "Hi, this is Anna from Voni. How can I help?"  (reply_create gap 700ms)',
  ' 4.20s  VONI    "Sure, I will send that to your inbox right now."  (reply_create gap 800ms)',
  ' 7.30s  VONI    "Voni, WhatsApp, Lime 42."  (reply_create gap 900ms)',
  ' 9.00s  VONI    "Thanks for calling, goodbye."  (reply_create gap 500ms)',
];

/** A second English call: same shape as the baseline, different words. */
const EN_ALT = [
  "sess_en_alt  agent=agent_audrey  21.0s  end=client_end",
  ' 1.10s  VONI    "Hello, this is Audrey from Voni. How can I help?"  (reply_create gap 700ms)',
  ' 4.20s  VONI    "Of course, I will send that to your inbox right now."  (reply_create gap 800ms)',
  ' 7.30s  VONI    "Voni, WhatsApp, Lime 42."  (reply_create gap 900ms)',
  ' 9.00s  VONI    "Thanks for calling, goodbye."  (reply_create gap 500ms)',
];

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
  });
}

test("a Spanish reply that leaks English words is counted", () => {
  const count = countEnglishLeak(
    agentTurnsFromTranscript(ES_LEAK, "sess_es_clean"),
    "es",
  );

  assert.equal(count.status, "leak");
  assert.equal(count.applicable, true);
  assert.equal(count.turns, 3);
  assert.equal(count.count, 1);
  assert.equal(count.rate, 1 / 3);
  assert.equal(count.reportOnly, true);
  assert.deepEqual(
    count.findings.map((finding) => finding.turn),
    [2],
  );
  assert.deepEqual(count.findings[0]!.words, ["i", "can", "you", "the"]);
  assert.match(count.findings[0]!.text, /send you the email/);
});

test("a clean Spanish reply is not counted, proper nouns and the Locale's own words exempt", () => {
  const count = countEnglishLeak(
    agentTurnsFromTranscript(ES_CLEAN, "sess_es_clean"),
    "es",
  );

  assert.equal(count.status, "clear");
  assert.equal(count.count, 0);
  assert.equal(count.turns, 3);
  assert.equal(count.rate, 0);
  assert.deepEqual(count.findings, []);
});

test("proper nouns stay exempt mid-sentence, a sentence-initial English word does not", () => {
  const proper = countEnglishLeak(
    agentTurnsFromTranscript(
      [' 2.00s  VONI    "Escucha, The Beatles suenan bien."  (x)'],
      "s",
    ),
    "es",
  );
  assert.equal(
    proper.count,
    0,
    "a capitalised word mid-sentence is a proper noun",
  );

  const initial = countEnglishLeak(
    agentTurnsFromTranscript(
      [' 2.00s  VONI    "The Beatles suenan bien."  (x)'],
      "s",
    ),
    "es",
  );
  assert.equal(initial.count, 1, "a sentence-initial English word is a leak");
  assert.deepEqual(initial.findings[0]!.words, ["the"]);
});

test("words that are genuine in a Locale are not English leaks", () => {
  const german = countEnglishLeak(
    agentTurnsFromTranscript(
      [
        ' 2.00s  VONI    "Was kann ich für Sie tun? Ich will helfen, am Telefon."  (x)',
      ],
      "s",
    ),
    "de",
  );
  assert.equal(german.count, 0, "was/will/am are German words, not leaks");

  const spanish = countEnglishLeak(
    agentTurnsFromTranscript(
      [
        ' 2.00s  VONI    "He revisado tu correo y has recibido el enlace."  (x)',
      ],
      "s",
    ),
    "es",
  );
  assert.equal(spanish.count, 0, "he/has are Spanish words, not leaks");

  const portuguese = countEnglishLeak(
    agentTurnsFromTranscript(
      [' 2.00s  VONI    "Do escritório, envio o email."  (x)'],
      "s",
    ),
    "pt",
  );
  assert.equal(portuguese.count, 0, "do is a Portuguese word, not a leak");
});

test("the English baseline measures a false-positive rate and never applies the counter", () => {
  const count = countEnglishLeak(
    agentTurnsFromTranscript(EN_BASELINE, "sess_en_base"),
    "en",
  );

  assert.equal(count.status, "not-applicable");
  assert.equal(count.applicable, false);
  assert.equal(count.count, 0);
  assert.equal(count.rate, null);

  const baseline = count.englishBaseline;
  assert.ok(baseline, "an English subject carries the measured baseline");
  assert.equal(baseline.turns, 4);
  assert.equal(
    baseline.scopedFlagged,
    0,
    "the Locale guard keeps English free of flags",
  );
  assert.equal(baseline.scopedRate, 0);
  // Three turns are real English; the brand-only turn is exempt by the
  // proper-noun allowlist even when the Locale guard is dropped.
  assert.equal(baseline.unscopedFlagged, 3);
  assert.equal(baseline.unscopedRate, 0.75);
});

test("a transcript with no agent turn is unmeasured, never a clean zero", () => {
  const count = countEnglishLeak(agentTurnsFromTranscript([], null), "es");
  assert.equal(count.status, "unmeasured");
  assert.equal(count.count, 0);
  assert.equal(count.turns, 0);
  assert.equal(count.rate, null);
});

test("an unknown or undetermined Locale is never scanned, so no silent English default", () => {
  const count = countEnglishLeak(
    agentTurnsFromTranscript(
      [' 2.00s  VONI    "I can send you the email."  (x)'],
      "s",
    ),
    "unknown",
  );
  assert.equal(count.status, "not-applicable");
  assert.equal(count.applicable, false);
  assert.equal(count.count, 0);
});

test("the artifact records the English baseline and the promotion decision", () => {
  const english = artifactFor("audrey", EN_BASELINE, "run-en-base");

  assert.ok(english.englishLeak, "the artifact carries the counter");
  assert.equal(english.englishLeak.status, "not-applicable");
  assert.equal(english.englishLeak.applicable, false);
  assert.equal(english.englishLeak.count, 0);
  assert.equal(english.englishLeak.turns, 4);
  assert.equal(english.englishLeak.rate, null);
  assert.equal(english.englishLeak.locale, "en");
  assert.equal(english.englishLeak.reportOnly, true);
  assert.deepEqual(english.englishLeak.promotion, ENGLISH_LEAK_PROMOTION);
  assert.equal(english.englishLeak.promotion.gating, false);
  assert.equal(english.englishLeak.englishBaseline?.turns, 4);
  assert.equal(english.englishLeak.englishBaseline?.scopedFlagged, 0);

  // A stored artifact read back from disk re-derives the same baseline.
  const fromArtifact = englishLeakForArtifact(
    JSON.parse(JSON.stringify(english)),
  );
  assert.equal(fromArtifact.status, "not-applicable");
  assert.equal(fromArtifact.englishBaseline?.turns, 4);
});

test("a withdrawn voice is refused by name, never measured as a demo subject", () => {
  for (const voice of ["malvina", "donatien", "jorg", "benicio"]) {
    assert.throws(
      () => artifactFor(voice, ES_LEAK, `run-${voice}-refused`),
      (error: unknown) =>
        error instanceof SubjectError &&
        error.field === "agent" &&
        new RegExp(`unknown gate voice "${voice}"`).test(error.message),
      `${voice} is withdrawn from the English-only roster`,
    );
  }
});

test("the counter is report-only: two English runs have identical gates", () => {
  const base = artifactFor("audrey", EN_BASELINE, "run-en-base");
  const alt = artifactFor("audrey", EN_ALT, "run-en-alt");

  assert.deepEqual(base.gates, alt.gates);
  assert.deepEqual(base.subScores, alt.subScores);
  assert.deepEqual(base.beats, alt.beats);
  assert.deepEqual(base.replyGap, alt.replyGap);

  const names = [
    ...base.gates.map((gate) => gate.name),
    ...base.subScores.map((sub) => sub.name),
  ];
  assert.ok(!names.some((name) => /leak|english/i.test(name)));
});

test("the compact report exposes the English baseline, never a leak rate", () => {
  const english = buildInspectReport(
    artifactFor("audrey", EN_BASELINE, "run-en-base"),
  );
  assert.equal(english.englishLeak.status, "not-applicable");
  assert.equal(english.englishLeak.englishBaseline?.scopedFlagged, 0);
  const englishText = formatInspectReport(english);
  assert.match(englishText, /english-leak \(report-only, never gated\)/);
  assert.match(englishText, /not applied to English/);
  assert.match(englishText, /FP 0\.00 \(0\/4\)/);
  assert.match(englishText, /unscoped scan 0\.75 \(3\/4\)/);
});

test("promotion is a new record added later, never an edit to the report-only one", () => {
  assert.deepEqual(ENGLISH_LEAK_PROMOTION, {
    gating: false,
    decidedAt: null,
    source:
      "voice-parity 76: report-only until the English false-positive rate is known; " +
      "promotion adds a new record beside this one and is never an edit of it",
  });
  assert.ok(Object.isFrozen(ENGLISH_LEAK_PROMOTION));
  assert.equal(englishLeakIsGating(), false);

  const promoted: EnglishLeakPromotion = {
    gating: true,
    decidedAt: "2026-11-01",
    source: "owner sign-off: English FP 0.00 over N live runs",
  };
  const active = latestEnglishLeakPromotion([ENGLISH_LEAK_PROMOTION, promoted]);
  assert.equal(active.gating, true);
  assert.equal(
    ENGLISH_LEAK_PROMOTION.gating,
    false,
    "the original record is untouched",
  );
});
