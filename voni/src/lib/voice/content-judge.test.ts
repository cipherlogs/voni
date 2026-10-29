import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildContentJudgePrompt,
  CONTENT_JUDGE_DISCLAIMER,
  CONTENT_JUDGE_VERSION,
  judgeContent,
  MACHINE_SCORE_CEILING,
  scoreContent,
  type ContentJudgeEvidence,
  type ContentJudgeInput,
} from "./content-judge";

type Fixture = {
  recordedAt: string;
  recordedWith: string;
  judgeVersion: string;
  cases: Record<string, { input: ContentJudgeInput; evidence: ContentJudgeEvidence }>;
};

const fixture = JSON.parse(
  readFileSync(new URL("./content-judge.fixtures.json", import.meta.url), "utf8"),
) as Fixture;
const cases = fixture.cases;

test("the recorded fixture belongs to this judge version", () => {
  assert.equal(fixture.judgeVersion, CONTENT_JUDGE_VERSION);
  assert.match(fixture.recordedWith, /generateJSON/);
});

test("scores a transcript on naturalness and code-switching against the stated English baseline", () => {
  const { input, evidence } = cases.spanishLeak;
  const judgement = scoreContent(input, evidence);

  assert.equal(judgement.locale, "es");
  assert.deepEqual(judgement.baseline, {
    locale: "en",
    text: "Hi, I'm Voni! Let's try something cool: I'll show you what I can do while we talk. Ready?",
  });
  assert.equal(judgement.scores.naturalness, 1);
  assert.equal(judgement.scores.codeSwitching, 1);
  assert.equal(judgement.judgeVersion, CONTENT_JUDGE_VERSION);
});

test("a transcript with an English leak is flagged", () => {
  const { input, evidence } = cases.spanishLeak;
  const judgement = scoreContent(input, evidence);

  assert.equal(judgement.verdict, "flagged");
  assert.equal(judgement.flagged, true);
  assert.equal(judgement.leaks.length, 1);
  assert.equal(judgement.leaks[0]?.text, "So, and then we can look at your business.");
  assert.equal(judgement.leaks[0]?.turn, 2);
  assert.ok(
    judgement.reasons.some((reason) => /English|foreign-language/i.test(reason)),
    "the reasons name the leak, not just a number",
  );
});

test("a leak flags the judgement on its own, even when both scores are clean", () => {
  const { input } = cases.spanishClean;
  const judgement = scoreContent(input, {
    naturalness: 4,
    codeSwitching: 4,
    leaks: [{ text: "so and then", turn: 2, reason: "English phrase inside a Spanish reply" }],
  });

  assert.equal(judgement.flagged, true);
  assert.equal(judgement.verdict, "flagged");
  assert.equal(judgement.scores.naturalness, 4);
});

test("a clean transcript in the target language is not flagged", () => {
  const { input, evidence } = cases.spanishClean;
  const judgement = scoreContent(input, evidence);

  assert.equal(judgement.verdict, "clear");
  assert.equal(judgement.flagged, false);
  assert.equal(judgement.scores.naturalness, 4);
  assert.equal(judgement.scores.codeSwitching, 4);
  assert.deepEqual(judgement.leaks, []);
});

test("the judgement names the locale, the baseline and the reasons", () => {
  const { input, evidence } = cases.spanishClean;
  const judgement = scoreContent(input, evidence);

  assert.equal(judgement.locale, "es");
  assert.equal(judgement.baseline.locale, "en");
  assert.ok(judgement.baseline.text.length > 0);
  assert.ok(judgement.reasons.length >= 1);
  for (const reason of judgement.reasons) assert.equal(reason.trim(), reason);
});

test("the judge never claims a five-out-of-five native verdict", () => {
  const { input } = cases.spanishClean;
  // Even a model that ignores the 1-4 instruction and answers on the reviewer
  // scale cannot become a native five: the machine caps at 4 and says so.
  const judgement = scoreContent(input, {
    naturalness: 5,
    codeSwitching: 5,
    leaks: [],
    reasons: ["native-like Spanish"],
  });

  assert.equal(MACHINE_SCORE_CEILING, 4);
  assert.equal(judgement.machineScoreCeiling, 4);
  assert.equal(judgement.scores.naturalness, 4);
  assert.equal(judgement.scores.codeSwitching, 4);
  assert.equal(judgement.nativeVerdict, "not-reviewed");
  assert.equal(judgement.humanReviewRequired, true);
  assert.equal(judgement.disclaimer, CONTENT_JUDGE_DISCLAIMER);
  assert.match(judgement.disclaimer, /not a native reviewer/i);
  assert.ok(![judgement.scores.naturalness, judgement.scores.codeSwitching].includes(5));
});

test("the prompt states the target locale and the baseline it scores against", () => {
  const { input } = cases.spanishClean;
  const prompt = buildContentJudgePrompt(input);

  assert.match(prompt.system, /not a native reviewer/i);
  assert.match(prompt.user, /Spanish \(es\)/);
  assert.match(prompt.user, /BASELINE \(English, en\)/);
  assert.ok(prompt.user.includes(input.baseline.text));
  assert.ok(prompt.user.includes("[2] agent: Perfecto. ¿De qué se trata tu negocio?"));
});

test("a plain string transcript is judged as one agent turn", () => {
  const judgement = scoreContent(
    {
      locale: "fr",
      transcript: "Bonjour, ici Voni ! On y va ?",
      baseline: { locale: "en", text: "Hi, I'm Voni! Ready?" },
    },
    { naturalness: 4, codeSwitching: 4, reasons: ["natural French"] },
  );

  assert.equal(judgement.flagged, false);
  assert.ok(judgement.reasons.length > 0);
});

test("a transcript with no agent turn is refused, never cleared", () => {
  const { input } = cases.spanishClean;
  assert.throws(
    () =>
      scoreContent(
        { ...input, transcript: [{ speaker: "caller", text: "Solo habla el cliente." }] },
        { naturalness: 4, codeSwitching: 4 },
      ),
    /agent turn/i,
  );
});

test("an unstated or empty baseline is refused", () => {
  const { input } = cases.spanishClean;
  assert.throws(
    () => scoreContent({ ...input, baseline: { locale: "en", text: "   " } }, { naturalness: 4, codeSwitching: 4 }),
    /baseline/i,
  );
  assert.throws(
    () => scoreContent({ ...input, locale: "  " }, { naturalness: 4, codeSwitching: 4 }),
    /locale/i,
  );
});

test("a clear judgement still states a reason", () => {
  const { input } = cases.spanishClean;
  const judgement = scoreContent(input, { naturalness: 4, codeSwitching: 4, leaks: [], reasons: [] });

  assert.equal(judgement.flagged, false);
  assert.equal(judgement.reasons.length, 1);
  assert.match(judgement.reasons[0] ?? "", /no defect detected/i);
});

test("judgeContent spends exactly one injected model call and scores its evidence", async () => {
  const { input, evidence } = cases.spanishLeak;
  let calls = 0;

  const judgement = await judgeContent(input, {
    ask: async (asked) => {
      calls += 1;
      assert.deepEqual(asked, input);
      return evidence;
    },
  });

  assert.equal(calls, 1);
  assert.equal(judgement.flagged, true);
  assert.equal(judgement.evidence.model, "muse-spark-1.3-contributor");
  assert.equal(judgement.evidence.provider, "Meta Model API");
});
