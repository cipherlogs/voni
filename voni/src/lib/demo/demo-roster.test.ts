import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEMO_VOICE_IDS, VONI_GREETINGS, voniConfig } from "./voni-agent";
import { buildDemoAgentBody } from "./stored-agents";
import { getVoice, tenantVoices, VOICES } from "@/lib/agents/voices";
import { voiceForLanguage } from "@/lib/agents/wizard";

/**
 * Demo-cascade ticket 04: the demo offers exactly five Locales, one voice each,
 * English first. The voice catalogue keeps every entry a stored agent may run
 * on; the tenant picker narrows to English while a stored non-English agent
 * still resolves.
 */

const LOCALES = ["en", "es", "fr", "de", "pt"] as const;

test("the demo roster is exactly five voices, one per Locale, English first", () => {
  assert.deepEqual(
    [...DEMO_VOICE_IDS],
    ["audrey", "malvina", "donatien", "jorg", "benicio"],
    "the demo picker's order is the product decision",
  );
  assert.deepEqual(
    DEMO_VOICE_IDS.map((voice) => getVoice(voice)?.languageCode),
    [...LOCALES],
    "each voice speaks the Locale it is offered for, in order",
  );
  assert.equal(new Set(DEMO_VOICE_IDS).size, DEMO_VOICE_IDS.length, "no voice is offered twice");
});

test("withdrawing a demo voice is the roster line, and every surface reads it", () => {
  // The picker (switcher), the mint's voice gate and the harness all derive
  // from DEMO_VOICE_IDS; no second roster may exist.
  const picker = readFileSync(new URL("../../components/voice-call.tsx", import.meta.url), "utf8");
  const mintGate = readFileSync(new URL("./stored-agents.ts", import.meta.url), "utf8");
  assert.match(picker, /DEMO_VOICE_IDS/, "the demo switcher is the roster");
  assert.match(mintGate, /DEMO_VOICE_IDS/, "the mint validates against the same roster");
  assert.doesNotMatch(
    picker,
    /"audrey"|"malvina"|"donatien"|"benicio"/,
    "the picker names no voice of its own: removing one is a roster edit",
  );
});

test("Italian is not offered in the demo, and its catalogue entry and rendering stay", () => {
  assert.equal(
    DEMO_VOICE_IDS.some((voice) => getVoice(voice)?.languageCode === "it"),
    false,
    "the demo offers five Locales and Italian is not one",
  );
  assert.ok(getVoice("giovanni"), "the Italian catalogue entry is untouched");
  assert.match(VONI_GREETINGS.it, /Voni/, "the Italian rendering stays, unused");
});

test("every demo body pins that voice's Locale and speaks that Locale's words", () => {
  for (const voice of DEMO_VOICE_IDS) {
    const locale = getVoice(voice)?.languageCode;
    assert.ok(locale, `${voice} is a catalogue voice`);
    const body = buildDemoAgentBody(voice);

    assert.deepEqual(body.voice, { voice_id: voice }, `${voice}: the body runs the picked voice`);
    assert.deepEqual(body.input.language_codes, [locale], `${voice}: the Locale is pinned, not English by default`);
    assert.equal(
      body.greeting,
      VONI_GREETINGS[locale],
      `${voice}: the opening words come from the per-Locale rendering layer`,
    );
    assert.equal(voniConfig(voice).greeting, VONI_GREETINGS[locale], `${voice}: one greeting source`);
    if (locale !== "en") {
      assert.notEqual(
        body.greeting,
        VONI_GREETINGS.en,
        `${voice}: a non-English demo never opens in English scenario text`,
      );
    }
  }
});

test("the catalogue keeps every stored voice, including the non-English ones", () => {
  for (const voice of ["alba", "anna", "lola", "estelle", "jorg", "rafael", "giovanni"]) {
    assert.ok(getVoice(voice), `${voice} still resolves for a stored agent`);
  }
  for (const voice of ["audrey", "malvina", "donatien", "benicio"]) {
    assert.ok(getVoice(voice), `${voice} is in the catalogue`);
  }
  assert.ok(VOICES.length >= 20, "the four new voices are additions, not replacements");
});

test("the tenant picker offers English voices only, plus the agent's stored voice", () => {
  assert.deepEqual(
    tenantVoices().filter((voice) => voice.languageCode !== "en"),
    [],
    "a tenant picking a new voice is offered English only",
  );

  // A stored agent on another Locale still opens with the voice it has: the
  // picker includes it (so the selection is visible) and validation is not
  // narrowed to the picker.
  for (const stored of ["lola", "estelle", "jorg", "rafael", "giovanni"]) {
    const offered = tenantVoices(stored);
    assert.ok(
      offered.some((voice) => voice.id === stored),
      `${stored}: the stored voice rides with the English list`,
    );
    assert.equal(offered.at(-1)?.id, stored, `${stored}: it is the extra row, not a language group`);
    assert.ok(
      offered.filter((voice) => voice.id !== stored).every((voice) => voice.languageCode === "en"),
      `${stored}: everything else offered is English`,
    );
  }
  assert.deepEqual(
    tenantVoices("not-a-voice"),
    tenantVoices(),
    "an unknown stored id cannot invent a picker row",
  );

  // The language/voice pairing a stored draft uses still resolves unchanged:
  // the picker narrows what is newly offered, not what already exists.
  assert.deepEqual(
    voiceForLanguage("es", "lola"),
    { voiceId: "lola", changed: false },
    "a stored Spanish agent keeps lola when its Locale is already Spanish",
  );
  assert.deepEqual(
    voiceForLanguage("it", "giovanni"),
    { voiceId: "giovanni", changed: false },
    "a stored Italian agent keeps giovanni",
  );
});

test("the tenant pickers derive from tenantVoices, not from the whole catalogue", () => {
  for (const file of [
    "../../components/agent-config-form.tsx",
    "../../components/wizard/voice-field.tsx",
    "../../components/settings-sections.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /voicesByLanguage\(tenantVoices\(/, `${file}: the picker is filtered to English`);
  }
});
