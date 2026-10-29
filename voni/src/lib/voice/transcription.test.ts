import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentKeyterms,
  buildAgentTranscriptionPrompt,
  NEUTRAL_KEYTERMS,
} from "./transcription";
import { REAL_ESTATE_TEMPLATE, type AgentConfig } from "@/lib/agents/config";
import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";

const DENTAL: AgentConfig = {
  ...REAL_ESTATE_TEMPLATE,
  mission: "Book dental appointments and get urgent cases seen sooner.",
  identity: { name: "Nadia", role: "clinic coordinator" },
  detect: [
    { key: "reason", label: "Reason for calling", description: "", sensitive: false },
    { key: "urgency", label: "Urgency", description: "", sensitive: false },
  ],
  tools: ["check_calendar", "schedule_follow_up", "transfer_to_human"],
  customTools: [],
  keyterms: ["Ozempic", "root canal"],
};

test("neutral fallback names no vertical", () => {
  assert.deepEqual(NEUTRAL_KEYTERMS, ["Voni", "WhatsApp"]);
});

test("keyterms derive from the agent's own config, not a global list", () => {
  const terms = buildAgentKeyterms(DENTAL);
  for (const term of ["Nadia", "Reason", "calling", "Urgency", "calendar", "Ozempic", "root canal", "manager"]) {
    assert.ok(terms.includes(term), term);
  }
  // No property nouns leak into a dental agent.
  for (const term of ["mortgage", "villa", "Yas Island", "Bayut"]) {
    assert.ok(!terms.includes(term), term);
  }
  assert.ok(terms.length <= 100);
});

test("the template's vertical flavor rides on its own keyterms field", () => {
  const terms = buildAgentKeyterms(REAL_ESTATE_TEMPLATE);
  for (const term of ["Yas Island", "AED", "VONI-AUH", "Bayut", "mortgage"]) {
    assert.ok(terms.includes(term), term);
  }
});

test("owner keyterms dedupe case-insensitively and cap at 100", () => {
  const terms = buildAgentKeyterms({
    ...DENTAL,
    keyterms: ["nadia", "NADIA", ...Array.from({ length: 200 }, (_, i) => `Term${i}`)],
  });
  assert.equal(terms.filter((t) => t.toLowerCase() === "nadia").length, 1);
  assert.equal(terms.length, 100);
});

test("transcription prompt describes the call without instructing", () => {
  const prompt = buildAgentTranscriptionPrompt(DENTAL);
  assert.match(prompt, /clinic coordinator/);
  assert.match(prompt, /Book dental appointments/);
  assert.match(prompt, /Nadia/);
  assert.doesNotMatch(prompt, /transcribe verbatim|do not|never/i);
  assert.ok(prompt.length <= 500);
});

test("a Spanish call's recognition request carries Spanish terms", () => {
  const terms = buildAgentKeyterms({ ...DENTAL, conversationLanguage: "es" });
  assert.ok(terms.includes("teléfono"), terms.join(", "));
  assert.equal(terms.includes("phone"), false);
});

test("a call whose Locale is pinned by its voice carries that Locale's terms", () => {
  const terms = buildAgentKeyterms({ ...DENTAL, languageCodes: ["es"] });
  assert.ok(terms.includes("teléfono"), terms.join(", "));
  assert.equal(terms.some((term) => term.toLowerCase() === "phone"), false);
});

test("platform English tool nouns do not leak into a non-English recognition request", () => {
  const terms = buildAgentKeyterms({ ...DENTAL, conversationLanguage: "es" });
  for (const english of [
    "calendar", "appointment", "slot", "follow-up", "callback",
    "manager", "supervisor", "human", "person",
  ]) {
    assert.equal(terms.includes(english), false, english);
  }
});

test("a Spanish call's transcription prompt is Spanish, not the English scene", () => {
  const prompt = buildAgentTranscriptionPrompt({ ...DENTAL, conversationLanguage: "es" });
  assert.equal(
    prompt,
    "Una llamada telefónica de clinic coordinator. " +
      "Book dental appointments and get urgent cases seen sooner. " +
      "Habla Nadia. Quien llama menciona Reason for calling, Urgency.",
  );
  assert.doesNotMatch(prompt, /phone call|Callers mention/);
  assert.doesNotMatch(prompt, /transcribe verbatim|do not|never/i);
});

test("every spoken Locale's prompt describes the call in its own language", () => {
  const markers = [
    ["es", /llamada telefónica/],
    ["fr", /appel téléphonique/],
    ["de", /Telefonanruf/],
    ["it", /chiamata telefonica/],
    ["pt", /chamada telefónica/],
  ] as const;
  for (const [locale, marker] of markers) {
    const prompt = buildAgentTranscriptionPrompt({ ...DENTAL, conversationLanguage: locale });
    assert.match(prompt, marker, locale);
    assert.match(prompt, /Nadia/, locale);
    assert.doesNotMatch(prompt, /phone call|Callers mention/, locale);
    assert.ok(prompt.length <= 500, locale);
  }
});

test("a missing scene is a hole, never an English prompt", () => {
  for (const locale of ["ar", "xx"]) {
    const prompt = buildAgentTranscriptionPrompt(DENTAL, locale);
    assert.equal(prompt, "", locale);
  }
});

test("automatic detection keeps the English scene as the documented exception", () => {
  const prompt = buildAgentTranscriptionPrompt(DENTAL, null);
  assert.match(prompt, /A clinic coordinator phone call/);
  assert.match(prompt, /Nadia/);
});

test("the term budget holds in every Locale", () => {
  for (const locale of CONVERSATION_LANGUAGES) {
    const terms = buildAgentKeyterms({
      ...DENTAL,
      conversationLanguage: locale,
      keyterms: Array.from({ length: 200 }, (_, i) => `Term${i}`),
    });
    assert.equal(terms.length, 100, locale);
  }
});
