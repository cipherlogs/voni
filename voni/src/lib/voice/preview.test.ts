import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { VOICES } from "@/lib/agents/voices";
import { bindCascadeVoice } from "@/lib/demo/subject";
import {
  CASCADE_PREVIEW_PREFIX,
  MAX_PREVIEW_CHARS,
  buildPreviewText,
  cascadePreviewGap,
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

test("a cascade preview with no committed asset is reported, never served as a dead URL", () => {
  const evidence = JSON.parse(
    readFileSync(new URL("../../../evidence/cascade-clips/clips.json", import.meta.url), "utf8"),
  ) as {
    clips: Array<{ voice: string; asset: string }>;
    blockers: Array<{ voice: string; reason: string; command: string }>;
  };
  const committed = evidence.clips.map((clip) => clip.asset.replace(/^voni\//, ""));
  const gaps = VOICES.map((voice) => cascadePreviewGap(voice.id, committed)).filter(
    (gap): gap is NonNullable<typeof gap> => gap !== null,
  );
  const blocked = new Set(evidence.blockers.map((blocker) => blocker.voice));

  // Every URL that is not backed by a committed asset must be a named blocker.
  for (const gap of gaps) {
    assert.equal(
      blocked.has(gap.voiceId),
      true,
      `${gap.message}; it must also be a named blocker with the command that finishes it`,
    );
    assert.equal(
      existsSync(new URL(`../../../public/voices/cascade/${gap.voiceId}.wav`, import.meta.url)),
      false,
      `${gap.voiceId}: the asset is genuinely absent, so the gap is not stale`,
    );
  }
  assert.deepEqual(
    gaps.map((gap) => gap.voiceId).sort(),
    evidence.blockers.map((blocker) => blocker.voice).sort(),
    "the uncommitted previews and the manifest's blockers are the same five voices",
  );
  for (const blocker of evidence.blockers) {
    assert.match(blocker.command, /render_clips\.py/, "a blocker names the command that renders it");
    assert.ok(blocker.reason.trim().length > 0, "a blocker names why");
  }

  // The one committed cascade preview is playable and unchanged.
  assert.equal(cascadePreviewGap("jorg", committed), null);
  const missing = cascadePreviewGap(
    "jorg",
    committed.filter((asset) => !asset.endsWith("/jorg.wav")),
  );
  assert.ok(missing, "a URL whose asset is absent is reported, not returned as playable");
  assert.equal(missing.asset, "public/voices/cascade/jorg.wav");
  assert.match(missing.message, /not committed/);
  assert.equal(cascadePreviewUrl("jorg"), "/voices/cascade/jorg.wav");
  assert.equal(
    existsSync(new URL("../../../public/voices/cascade/jorg.wav", import.meta.url)),
    true,
    "the jorg preview's committed asset is the one that exists",
  );
  assert.equal(cascadePreviewGap("juergen", committed), null, "a voice with no binding has no URL");
  assert.equal(
    cascadePreviewUrl("alba"),
    null,
    "a catalog voice outside the demo roster has the managed clip only, not a dead cascade URL",
  );
});

test("a voice with no binding has no preview, never another voice's", () => {
  assert.equal(
    cascadePreviewUrl("jorg"),
    "/voices/cascade/jorg.wav",
    "the chosen German voice has its own preview",
  );
  assert.equal(
    cascadePreviewUrl("juergen"),
    null,
    "the retired German id has no preview and never borrows jorg's",
  );
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
