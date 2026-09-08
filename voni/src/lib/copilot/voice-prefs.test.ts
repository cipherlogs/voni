import test from "node:test";
import assert from "node:assert/strict";
import {
  coerceCopilotVoicePrefs,
  copilotVoicePrefsSchema,
  DEFAULT_COPILOT_VOICE_PREFS,
  prefsLanguageCodes,
  prefsPairingNote,
} from "./voice-prefs";

test("defaults keep historical behaviour: ivy + pinned English", () => {
  assert.deepEqual(DEFAULT_COPILOT_VOICE_PREFS, { voiceId: "ivy", language: "en" });
  assert.ok(copilotVoicePrefsSchema.safeParse(DEFAULT_COPILOT_VOICE_PREFS).success);
});

test("catalog voices validate; unknown ids fail in Settings, not mid-call", () => {
  assert.ok(copilotVoicePrefsSchema.safeParse({ voiceId: "alba", language: "en" }).success);
  assert.ok(copilotVoicePrefsSchema.safeParse({ voiceId: "estelle", language: "fr" }).success);
  assert.equal(
    copilotVoicePrefsSchema.safeParse({ voiceId: "morgan", language: "en" }).success,
    false,
  );
  assert.equal(
    copilotVoicePrefsSchema.safeParse({ voiceId: "alba", language: "xx" }).success,
    false,
  );
});

test("stale or partial stored rows coerce to safe defaults", () => {
  assert.deepEqual(coerceCopilotVoicePrefs(null), DEFAULT_COPILOT_VOICE_PREFS);
  assert.deepEqual(coerceCopilotVoicePrefs({ voiceId: "morgan" }), DEFAULT_COPILOT_VOICE_PREFS);
  assert.deepEqual(coerceCopilotVoicePrefs({ language: "fr" }), {
    voiceId: "ivy",
    language: "fr",
  });
});

test("auto omits language_codes; pinned codes send exactly one", () => {
  assert.equal(prefsLanguageCodes({ voiceId: "ivy", language: "auto" }), null);
  assert.deepEqual(prefsLanguageCodes({ voiceId: "alba", language: "en" }), ["en"]);
  assert.deepEqual(prefsLanguageCodes({ voiceId: "alba", language: "ar" }), ["ar"]);
});

test("pairing note only for voice/language mismatches", () => {
  assert.equal(prefsPairingNote({ voiceId: "alba", language: "en" }), null);
  assert.equal(prefsPairingNote({ voiceId: "alba", language: "auto" }), null);
  const note = prefsPairingNote({ voiceId: "alba", language: "ar" });
  assert.ok(note?.includes("Alba"));
  assert.ok(note?.includes("Arabic"));
  assert.ok(note?.includes("English"));
});
