import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_LANGUAGES,
  DEFAULT_WIZARD_VOICE_ID,
  defaultGreeting,
  EMPTY_WIZARD_DRAFT,
  LOCALIZED_GREETINGS,
  MAX_OUTCOME_LENGTH,
  MAX_OUTCOMES,
  MAX_STYLE_LENGTH,
  MAX_STYLE_TRAITS,
  normalizeTag,
  normalizeWizardDraft,
  validateWizardDraft,
  voiceForLanguage,
  type WizardDraft,
} from "./wizard";
import { agentConfigSchema, REAL_ESTATE_TEMPLATE } from "./config";
import { JOB_INPUT_SCHEMAS, JOB_RESULT_SCHEMAS } from "@/lib/jobs/kinds";

const BASE: WizardDraft = {
  outcomes: ["Qualify property leads and book viewings"],
  agentName: "Sara",
  styleTraits: ["Friendly"],
  conversationLanguage: "en",
  voiceId: "anna",
};

test("limits match the plan: 1-12 outcomes x140, 0-5 style x60, name 1-120", () => {
  assert.equal(MAX_OUTCOMES, 12);
  assert.equal(MAX_OUTCOME_LENGTH, 140);
  assert.equal(MAX_STYLE_TRAITS, 5);
  assert.equal(MAX_STYLE_LENGTH, 60);
});

test("empty wizard draft starts blank with English + anna", () => {
  assert.deepEqual(EMPTY_WIZARD_DRAFT.outcomes, []);
  assert.equal(EMPTY_WIZARD_DRAFT.agentName, "");
  assert.deepEqual(EMPTY_WIZARD_DRAFT.styleTraits, []);
  assert.equal(EMPTY_WIZARD_DRAFT.conversationLanguage, "en");
  assert.equal(EMPTY_WIZARD_DRAFT.voiceId, DEFAULT_WIZARD_VOICE_ID);
});

test("normalizeTag trims and collapses whitespace without splitting commas", () => {
  assert.equal(normalizeTag("  Qualify  leads,\tbook   viewings  "), "Qualify leads, book viewings");
  assert.equal(normalizeTag("a,b,c"), "a,b,c");
});

test("normalizeWizardDraft cleans without inventing structure", () => {
  const out = normalizeWizardDraft({
    outcomes: ["  Qualify   leads  ", ""],
    agentName: "  Sara ",
    styleTraits: ["  Friendly  ", ""],
    conversationLanguage: "en",
    voiceId: "  anna ",
  });
  assert.deepEqual(out.outcomes, ["Qualify leads"]);
  assert.equal(out.agentName, "Sara");
  assert.deepEqual(out.styleTraits, ["Friendly"]);
  assert.equal(out.voiceId, "anna");
});

test("valid draft passes; empty outcomes/name fail", () => {
  assert.ok(validateWizardDraft(BASE).success);
  assert.ok(!validateWizardDraft({ ...BASE, outcomes: [] }).success);
  assert.ok(!validateWizardDraft({ ...BASE, agentName: "   " }).success);
});

test("duplicate outcomes and style reject case-insensitively", () => {
  assert.ok(
    !validateWizardDraft({
      ...BASE,
      outcomes: ["Qualify leads", "qualify  LEADS"],
    }).success,
  );
  assert.ok(
    !validateWizardDraft({ ...BASE, styleTraits: ["Friendly", "FRIENDLY"] }).success,
  );
});

test("length and count caps reject", () => {
  assert.ok(!validateWizardDraft({ ...BASE, outcomes: ["x".repeat(141)] }).success);
  assert.ok(
    !validateWizardDraft({ ...BASE, outcomes: Array.from({ length: 13 }, (_, i) => `Outcome ${i}`) })
      .success,
  );
  assert.ok(!validateWizardDraft({ ...BASE, styleTraits: ["x".repeat(61)] }).success);
  assert.ok(
    !validateWizardDraft({ ...BASE, styleTraits: ["a", "b", "c", "d", "e", "f"] }).success,
  );
  assert.ok(!validateWizardDraft({ ...BASE, agentName: "x".repeat(121) }).success);
});

test("voice must belong to the selected language", () => {
  assert.ok(validateWizardDraft({ ...BASE, conversationLanguage: "en", voiceId: "anna" }).success);
  assert.ok(
    validateWizardDraft({ ...BASE, conversationLanguage: "it", voiceId: "giovanni" }).success,
  );
  assert.ok(!validateWizardDraft({ ...BASE, conversationLanguage: "en", voiceId: "giovanni" }).success);
  assert.ok(!validateWizardDraft({ ...BASE, voiceId: "no-such-voice" }).success);
  assert.ok(
    !validateWizardDraft({ ...BASE, conversationLanguage: "ar" as never }).success,
  );
});

test("a restored non-English draft never resets to English/anna", () => {
  const parsed = validateWizardDraft({
    ...BASE,
    conversationLanguage: "es",
    voiceId: "lola",
  });
  assert.ok(parsed.success);
  if (parsed.success) {
    assert.equal(parsed.data.conversationLanguage, "es");
    assert.equal(parsed.data.voiceId, "lola");
  }
});

test("voiceForLanguage keeps compatible voices, falls back otherwise", () => {
  assert.deepEqual(voiceForLanguage("en", "anna"), { voiceId: "anna", changed: false });
  assert.deepEqual(voiceForLanguage("it", "giovanni"), { voiceId: "giovanni", changed: false });
  assert.deepEqual(voiceForLanguage("en", "giovanni"), { voiceId: "anna", changed: true });
  const de = voiceForLanguage("de", "anna");
  assert.equal(de.voiceId, "juergen");
  assert.equal(de.changed, true);
});

test("six localized greetings exist and render the name", () => {
  assert.deepEqual([...CONVERSATION_LANGUAGES].sort(), ["de", "en", "es", "fr", "it", "pt"]);
  for (const lang of CONVERSATION_LANGUAGES) {
    assert.ok(LOCALIZED_GREETINGS[lang].length > 0);
    assert.match(defaultGreeting(lang, "Sara"), /Sara/);
  }
  assert.match(defaultGreeting("en", "  "), /Voni/);
});

test("legacy AgentConfig objects without new fields still parse", () => {
  assert.ok(agentConfigSchema.safeParse(REAL_ESTATE_TEMPLATE).success);
  const withNew = {
    ...REAL_ESTATE_TEMPLATE,
    outcomes: ["Qualify property leads and book viewings"],
    styleTraits: ["Friendly"],
    conversationLanguage: "en" as const,
  };
  assert.ok(agentConfigSchema.safeParse(withNew).success);
  assert.ok(
    !agentConfigSchema.safeParse({ ...REAL_ESTATE_TEMPLATE, conversationLanguage: "ar" }).success,
  );
});

test("brief-only generation jobs remain valid; wizardDraft is optional", () => {
  const briefOnly = { brief: "Call new property leads nightly." };
  assert.ok(JOB_INPUT_SCHEMAS.agent_generation.safeParse(briefOnly).success);
  assert.ok(
    JOB_INPUT_SCHEMAS.agent_generation.safeParse({ ...briefOnly, wizardDraft: BASE }).success,
  );
  assert.ok(
    !JOB_INPUT_SCHEMAS.agent_generation.safeParse({
      ...briefOnly,
      wizardDraft: { ...BASE, conversationLanguage: "en", voiceId: "giovanni" },
    }).success,
  );
});

test("generation results accept an optional wizardDraft echo", () => {
  const base = {
    config: REAL_ESTATE_TEMPLATE,
    provider: "meta",
    model: "muse-spark",
    latencyMs: 12,
  };
  assert.ok(JOB_RESULT_SCHEMAS.agent_generation.safeParse(base).success);
  assert.ok(
    JOB_RESULT_SCHEMAS.agent_generation.safeParse({ ...base, wizardDraft: BASE }).success,
  );
});
