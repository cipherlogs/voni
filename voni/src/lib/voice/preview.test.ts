import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bindCascadeVoice } from "@/lib/demo/subject";
import {
  CASCADE_PREVIEW_PREFIX,
  MAX_PREVIEW_CHARS,
  buildPreviewText,
  cascadePreviewUrl,
  previewLocale,
  previewRateLimitExceeded,
  voicePreviewSchema,
} from "./preview";

/** The route's rationale is part of the contract ticket 132 corrects. */
const PREVIEW_ROUTE = readFileSync(
  new URL("../../app/api/voice-preview/route.ts", import.meta.url),
  "utf8",
);

test("voicePreviewSchema accepts catalog voices with short text", () => {
  const parsed = voicePreviewSchema.safeParse({ voiceId: "anna", text: "Hi." });
  assert.equal(parsed.success, true);
});

test("voicePreviewSchema rejects unknown voices, empty, and over-cap text", () => {
  assert.equal(
    voicePreviewSchema.safeParse({ voiceId: "morgan-freeman", text: "Hi." }).success,
    false,
  );
  assert.equal(voicePreviewSchema.safeParse({ voiceId: "anna", text: "   " }).success, false);
  assert.equal(
    voicePreviewSchema.safeParse({ voiceId: "anna", text: "x".repeat(MAX_PREVIEW_CHARS + 1) })
      .success,
    false,
  );
  assert.equal(MAX_PREVIEW_CHARS, 280);
});

test("buildPreviewText names the agent and falls back to Voni within the cap", () => {
  assert.equal(buildPreviewText("Sara"), "Hi, this is Sara. Can you hear me okay?");
  assert.equal(buildPreviewText("   "), "Hi, this is Voni. Can you hear me okay?");
  assert.ok(buildPreviewText("x".repeat(500)).length <= MAX_PREVIEW_CHARS);
});

test("previewLocale matches the voice accent family, defaulting to en-US", () => {
  assert.equal(previewLocale("anna"), "en-GB");
  assert.equal(previewLocale("alba"), "en-US");
  assert.equal(previewLocale("giovanni"), "it-IT");
  assert.equal(previewLocale("unknown-voice"), "en-US");
});

test("previewRateLimitExceeded allows bursts then reports retry seconds", () => {
  const now = 1_000_000;
  const nine = Array.from({ length: 9 }, (_, i) => now - i * 1000);
  assert.deepEqual(previewRateLimitExceeded(nine, now).exceeded, false);
  const ten = [...nine, now - 500];
  const limited = previewRateLimitExceeded(ten, now);
  assert.equal(limited.exceeded, true);
  assert.ok(limited.retryAfterSeconds > 0);
  // Stale hits outside the window do not count.
  const stale = Array.from({ length: 10 }, () => now - 61_000);
  assert.deepEqual(previewRateLimitExceeded(stale, now).exceeded, false);
});

test("every bound cascade voice's preview is its own native clip", () => {
  const subjects: ReadonlyArray<readonly [string, string]> = [
    ["anna", "en"],
    ["lola", "es"],
    ["estelle", "fr"],
    ["giovanni", "it"],
    ["rafael", "pt"],
  ];
  for (const [voice, locale] of subjects) {
    assert.equal(
      cascadePreviewUrl(voice),
      `${CASCADE_PREVIEW_PREFIX}/${voice}.wav`,
      `${voice}'s preview is its own committed clip`,
    );
    assert.equal(
      bindCascadeVoice(voice).locale,
      locale,
      `${voice} speaks ${locale}: the preview voice and Locale agree`,
    );
    assert.equal(
      previewLocale(voice).slice(0, 2),
      locale,
      `${voice}'s preview locale is its binding's Locale, not English as a fallback`,
    );
  }
  assert.equal(CASCADE_PREVIEW_PREFIX, "/voices/cascade");
});

test("a voice with no binding has no preview, never another voice's", () => {
  assert.equal(cascadePreviewUrl("juergen"), null, "German is open until the re-cast (ticket 130)");
  assert.equal(cascadePreviewUrl("morgan-freeman"), null, "a voice outside the catalog has none");
  assert.notEqual(cascadePreviewUrl("anna"), "/voices/anna.mp3", "the managed picker asset is separate");
});

test("the preview route no longer denies standalone synthesis and names its real rationale", () => {
  assert.ok(
    !/does not offer standalone|offers no standalone text-to-speech/i.test(PREVIEW_ROUTE),
    "the vendor does offer standalone streaming TTS; the old claim is corrected",
  );
  assert.match(PREVIEW_ROUTE, /does offer standalone streaming/, "the route names the real endpoint");
  assert.match(PREVIEW_ROUTE, /tts\.us\.assemblyai\.com/, "the endpoint it names is the one we render from");
  assert.match(PREVIEW_ROUTE, /native level/, "the preview level promise is stated");
  assert.match(PREVIEW_ROUTE, /not a second renderer/, "the route says why it does not synthesize per tap");
  assert.match(PREVIEW_ROUTE, /CASCADE_PREVIEW_PREFIX/, "the route points at the committed clips");
});
