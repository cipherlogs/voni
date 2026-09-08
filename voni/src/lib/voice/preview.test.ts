import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PREVIEW_CHARS,
  buildPreviewText,
  previewLocale,
  previewRateLimitExceeded,
  voicePreviewSchema,
} from "./preview";

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
