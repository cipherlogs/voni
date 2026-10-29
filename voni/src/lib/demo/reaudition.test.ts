/**
 * The W2 re-audition pack: one real non-English call assembled into evidence
 * (three captures, transcript, counters, content verdict) and one automated
 * decision written into the locale-rendering decision record.
 *
 * The tests build their own WAVs and replay a recorded content judgement, so
 * no network, provider or live call is involved. A synthetic pack is a fixture
 * for the mechanism; it is never evidence a gate can resolve on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReauditionIncompleteError,
  applyReauditionToAdr,
  assembleReauditionPack,
  assertReauditionComplete,
  formatReauditionSummary,
  type ReauditionRequest,
} from "./reaudition";
import { scoreContent, type ContentTurn } from "../voice/content-judge";

const SAMPLE_RATE = 24_000;
const BASELINE = {
  locale: "en",
  text: "Hi, I'm Voni! Let's try something cool: I'll show you what I can do while we talk. Ready?",
};

/** A WAV built from float samples in [-1, 1], independently of the decoder. */
function wavFrom(samples: number[], sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const blockAlign = channels * 2;
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * blockAlign, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  samples.forEach((value, index) => {
    const scaled = Math.max(-1, Math.min(1, value)) * 32_767;
    out.writeInt16LE(Math.round(scaled), 44 + index * 2);
  });
  return out;
}

function tone(seconds: number, hz = 440, amplitude = 0.4): number[] {
  const count = Math.round(seconds * SAMPLE_RATE);
  return Array.from(
    { length: count },
    (_unused, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE),
  );
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "reaudition-"));
}

function writeCapture(dir: string, name: string, seconds = 1): string {
  const path = join(dir, name);
  writeFileSync(path, wavFrom(tone(seconds)));
  return path;
}

const CLEAN_TURNS: ContentTurn[] = [
  {
    speaker: "agent",
    text: "¡Hola, soy Voni! Probemos algo genial: te muestro lo que puedo hacer mientras hablamos. ¿Listo?",
  },
  { speaker: "caller", text: "Sí, claro." },
  { speaker: "agent", text: "Perfecto. ¿De qué se trata tu negocio?" },
];

const LEAK_TURNS: ContentTurn[] = [
  CLEAN_TURNS[0]!,
  CLEAN_TURNS[1]!,
  { speaker: "agent", text: "Perfecto. So, and then we can look at your business." },
];

function cleanJudgement(locale = "es") {
  return scoreContent(
    { locale, baseline: BASELINE, transcript: CLEAN_TURNS },
    {
      naturalness: 4,
      codeSwitching: 4,
      leaks: [],
      reasons: ["No defect detected in the agent's Spanish turns."],
    },
  );
}

function flaggedJudgement(locale = "es") {
  return scoreContent(
    { locale, baseline: BASELINE, transcript: LEAK_TURNS },
    {
      naturalness: 1,
      codeSwitching: 1,
      leaks: [
        {
          text: "So, and then we can look at your business.",
          turn: 2,
          reason: "Full English sentence in a Spanish conversation.",
        },
      ],
      reasons: ["Turn 2 is entirely in English."],
    },
  );
}

function request(overrides: Partial<ReauditionRequest> = {}): ReauditionRequest {
  const dir = overrides.outDir ?? join(fixtureDir(), "pack");
  const source = fixtureDir();
  return {
    voice: "lola",
    locale: "es",
    baseline: BASELINE,
    transcript: CLEAN_TURNS,
    judgement: cleanJudgement(),
    captures: {
      reference: writeCapture(source, "reference.wav"),
      platform: writeCapture(source, "platform.wav"),
      delivered: writeCapture(source, "delivered.wav"),
    },
    outDir: dir,
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    ...overrides,
  };
}

test("a missing capture makes the pack incomplete and names the missing role, never a pass", () => {
  const source = fixtureDir();
  const outDir = join(fixtureDir(), "pack");
  const result = assembleReauditionPack({
    voice: "lola",
    locale: "es",
    baseline: BASELINE,
    transcript: CLEAN_TURNS,
    judgement: cleanJudgement(),
    captures: { reference: writeCapture(source, "reference.wav") },
    outDir,
    now: () => new Date("2026-10-29T12:00:00.000Z"),
  });

  assert.equal(result.pack.status, "incomplete");
  assert.equal(result.pack.verdict.decision, "unresolved");
  assert.deepEqual(
    result.pack.completeness.missing.map((entry) => entry.role),
    ["platform", "delivered"],
  );
  assert.match(result.pack.completeness.missing[0]!.error, /platform capture missing/);
  assert.match(result.pack.completeness.missing[1]!.error, /delivered capture missing/);
  assert.match(result.pack.verdict.sentence, /incomplete/);
  assert.match(result.pack.verdict.sentence, /never a pass/);
  assert.match(result.pack.verdict.basis.join(" "), /platform capture missing/);
});

test("a missing capture is never accepted even when the content judge flags a defect", () => {
  const source = fixtureDir();
  const result = assembleReauditionPack(
    request({
      judgement: flaggedJudgement(),
      transcript: LEAK_TURNS,
      captures: { reference: writeCapture(source, "reference.wav") },
      outDir: join(fixtureDir(), "pack"),
    }),
  );

  assert.equal(result.pack.content?.verdict, "flagged");
  assert.equal(result.pack.status, "incomplete");
  assert.equal(result.pack.verdict.decision, "unresolved");
  assert.equal(result.pack.verdict.justifiesRenderingLayer, null);
});

test("an unreadable capture is named as a blocker instead of throwing", () => {
  const source = fixtureDir();
  const broken = join(source, "broken.wav");
  writeFileSync(broken, Buffer.from("not a wav"));

  const result = assembleReauditionPack(
    request({
      captures: {
        reference: writeCapture(source, "reference.wav"),
        platform: broken,
        delivered: writeCapture(source, "delivered.wav"),
      },
      outDir: join(fixtureDir(), "pack"),
    }),
  );

  assert.equal(result.pack.status, "incomplete");
  assert.equal(result.pack.verdict.decision, "unresolved");
  const platform = result.pack.completeness.missing.find((entry) => entry.role === "platform");
  assert.ok(platform, "the platform capture is named");
  assert.match(platform.error, /platform capture unreadable/);
  assert.match(platform.error, /broken\.wav/);
});

test("a complete pack copies all three captures and records their hashes and formats", () => {
  const result = assembleReauditionPack(request());
  const pack = result.pack;

  assert.equal(pack.status, "complete");
  assert.equal(pack.completeness.missing.length, 0);
  for (const role of ["reference", "platform", "delivered"] as const) {
    const capture = pack.captures[role];
    assert.equal(capture.present, true);
    assert.match(capture.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.ok((capture.bytes ?? 0) > 44);
    assert.equal(capture.format?.sampleRate, SAMPLE_RATE);
    assert.equal(capture.format?.channels, 1);
    assert.ok(existsSync(join(result.packDir, "captures", `${role}.wav`)));
  }
  assert.ok(existsSync(result.packPath));
  assert.ok(existsSync(result.readmePath));
});

test("the pack records the transcript, the counters and the content judgement", () => {
  const pack = assembleReauditionPack(request()).pack;

  assert.equal(pack.transcript.turns.length, 3);
  assert.equal(pack.transcript.agentTurns, 2);
  assert.equal(pack.transcript.callerTurns, 1);
  assert.ok(pack.transcript.sha256.length === 64);
  assert.equal(pack.counters.englishLeaks, 0);
  assert.equal(pack.counters.codeSwitching, 4);
  assert.equal(pack.counters.naturalness, 4);
  assert.equal(pack.counters.englishLeakCounter.status, "clear");
  assert.equal(pack.counters.englishLeakCounter.reportOnly, true);
  assert.equal(pack.counters.answeredQuestions.status, "not-implemented");
  assert.equal(pack.counters.gating, "report-only");
  assert.equal(pack.content?.verdict, "clear");
  assert.equal(pack.content?.nativeVerdict, "not-reviewed");
});

test("an English leak is counted and quoted in the counters", () => {
  const pack = assembleReauditionPack(
    request({ judgement: flaggedJudgement(), transcript: LEAK_TURNS }),
  ).pack;

  assert.equal(pack.counters.englishLeaks, 1);
  assert.deepEqual(pack.counters.leakTexts, ["So, and then we can look at your business."]);
  assert.ok((pack.counters.englishLeakWords ?? 0) > 0);
  assert.equal(pack.counters.englishLeakCounter.status, "leak");
  assert.ok(pack.counters.englishLeakCounter.count >= 1);
  assert.ok(pack.counters.englishLeakCounter.findings[0]?.words.includes("we"));
});

test("clean content withdraws the locale-rendering decision", () => {
  const pack = assembleReauditionPack(request()).pack;

  assert.equal(pack.verdict.decision, "withdraw");
  assert.equal(pack.verdict.justifiesRenderingLayer, false);
  assert.match(pack.verdict.sentence, /held up/);
  assert.match(pack.verdict.sentence, /withdrawn/);
  assert.equal(pack.verdict.nativeReviewRequired, true);
});

test("flagged content accepts the locale-rendering decision", () => {
  const pack = assembleReauditionPack(
    request({ judgement: flaggedJudgement(), transcript: LEAK_TURNS }),
  ).pack;

  assert.equal(pack.verdict.decision, "accept");
  assert.equal(pack.verdict.justifiesRenderingLayer, true);
  assert.match(pack.verdict.sentence, /did not hold up/);
  assert.match(pack.verdict.sentence, /English/);
});

test("no transcript or no judgement leaves the verdict unresolved even with three captures", () => {
  const noTranscript = assembleReauditionPack(
    request({ transcript: [], outDir: join(fixtureDir(), "pack") }),
  ).pack;
  assert.equal(noTranscript.status, "incomplete");
  assert.equal(noTranscript.verdict.decision, "unresolved");
  assert.match(noTranscript.verdict.basis.join(" "), /transcript/);

  const noJudgement = assembleReauditionPack(
    request({ judgement: null, outDir: join(fixtureDir(), "pack") }),
  ).pack;
  assert.equal(noJudgement.status, "incomplete");
  assert.equal(noJudgement.verdict.decision, "unresolved");
  assert.match(noJudgement.verdict.basis.join(" "), /content judgement/);
});

test("a judgement for another locale is a named blocker, never scored into this pack", () => {
  const pack = assembleReauditionPack(
    request({ judgement: cleanJudgement("it"), outDir: join(fixtureDir(), "pack") }),
  ).pack;

  assert.equal(pack.status, "incomplete");
  assert.equal(pack.verdict.decision, "unresolved");
  assert.match(pack.verdict.basis.join(" "), /locale mismatch/);
});

test("a pending pack names the missing captures and prints the operator commands", () => {
  const outDir = join(fixtureDir(), "pending");
  const result = assembleReauditionPack({
    voice: "lola",
    locale: "es",
    baseline: BASELINE,
    transcript: [],
    judgement: null,
    captures: {},
    outDir,
    pending: true,
    now: () => new Date("2026-10-29T12:00:00.000Z"),
  });

  assert.equal(result.pack.status, "pending-live-call");
  assert.equal(result.pack.verdict.decision, "unresolved");
  assert.deepEqual(
    result.pack.completeness.missing.map((entry) => entry.role),
    ["reference", "platform", "delivered"],
  );
  const commands = [...(result.pack.operator?.commands ?? []), ...(result.pack.operator?.steps ?? [])].join("\n");
  assert.match(commands, /voice:reference -- --voice lola/);
  assert.match(commands, /qa:voice-session -- --session sess_/);
  assert.match(commands, /delivercapture=1/);
  assert.match(commands, /voice:reaudition -- --voice lola --locale es/);
  assert.ok(existsSync(result.packPath));
  assert.ok(existsSync(result.readmePath));
});

test("the incomplete guard throws an error that names every blocker", () => {
  const result = assembleReauditionPack({
    voice: "lola",
    locale: "es",
    baseline: BASELINE,
    transcript: [],
    judgement: null,
    captures: {},
    outDir: join(fixtureDir(), "pack"),
    pending: true,
  });

  assert.throws(
    () => assertReauditionComplete(result.pack),
    (error: unknown) =>
      error instanceof ReauditionIncompleteError &&
      /reference capture missing/.test(error.message) &&
      /platform capture missing/.test(error.message) &&
      /delivered capture missing/.test(error.message) &&
      /transcript/.test(error.message),
  );
});

test("a complete pack passes the incomplete guard", () => {
  const result = assembleReauditionPack(request());
  assert.doesNotThrow(() => assertReauditionComplete(result.pack));
});

test("a judgement for another locale is not copied into the pack content", () => {
  const pack = assembleReauditionPack(
    request({ judgement: cleanJudgement("it"), outDir: join(fixtureDir(), "pack") }),
  ).pack;
  assert.equal(pack.content, null);
  assert.equal(pack.counters.englishLeaks, null);
});

test("the decision-record section names the verdict, its date, evidence paths and basis", () => {
  const result = assembleReauditionPack(request());
  const markdown = applyReauditionToAdr(
    "# English is one rendering of six, not the source of meaning\n\n**Status: proposed.** Contingent on the re-audition.\n",
    result.pack,
  );

  assert.match(markdown, /^## Re-audition \(W2 gate\)$/m);
  assert.match(markdown, /\*\*Verdict: withdraw\*\* — 2026-10-29/);
  assert.match(markdown, /Content held up/);
  assert.match(markdown, /reaudition-runs|pack\.json/);
  assert.match(markdown, /\*\*Status: withdrawn\.\*\*/);
  assert.match(markdown, /native review/i);
});

test("an unresolved verdict leaves the decision record proposed", () => {
  const result = assembleReauditionPack({
    voice: "lola",
    locale: "es",
    baseline: BASELINE,
    transcript: [],
    judgement: null,
    captures: {},
    outDir: join(fixtureDir(), "pending"),
    pending: true,
    now: () => new Date("2026-10-29T12:00:00.000Z"),
  });
  const markdown = applyReauditionToAdr(
    "# English is one rendering of six, not the source of meaning\n\n**Status: proposed.** Contingent on the re-audition.\n",
    result.pack,
  );

  assert.match(markdown, /\*\*Verdict: unresolved\*\* — 2026-10-29/);
  assert.match(markdown, /\*\*Status: proposed\.\*\*/);
  assert.match(markdown, /never a pass/);
});

test("applying the section twice replaces it instead of duplicating it", () => {
  const result = assembleReauditionPack(request());
  const once = applyReauditionToAdr("# Decision\n\n**Status: proposed.**\n", result.pack);
  const twice = applyReauditionToAdr(once, result.pack);

  assert.equal(twice.match(/## Re-audition \(W2 gate\)/g)?.length, 1);
  assert.equal(twice, once);
});

test("the human summary says whether the content holds up and what is missing", () => {
  const complete = assembleReauditionPack(request());
  const summary = formatReauditionSummary(complete.pack);
  assert.match(summary, /Verdict: withdraw/);
  assert.match(summary, /Content held up/);
  assert.match(summary, /Captures: 3\/3/);

  const pending = assembleReauditionPack({
    voice: "lola",
    locale: "es",
    baseline: BASELINE,
    transcript: [],
    judgement: null,
    captures: {},
    outDir: join(fixtureDir(), "pending"),
    pending: true,
  });
  const pendingSummary = formatReauditionSummary(pending.pack);
  assert.match(pendingSummary, /Verdict: unresolved/);
  assert.match(pendingSummary, /Captures: 0\/3/);
  assert.match(pendingSummary, /reference capture missing/);
});

test("the pack written to disk round-trips as JSON", () => {
  const result = assembleReauditionPack(request());
  const parsed = JSON.parse(readFileSync(result.packPath, "utf8")) as {
    kind: string;
    status: string;
    verdict: { decision: string };
  };

  assert.equal(parsed.kind, "voice-reaudition-pack");
  assert.equal(parsed.status, "complete");
  assert.equal(parsed.verdict.decision, "withdraw");
});
