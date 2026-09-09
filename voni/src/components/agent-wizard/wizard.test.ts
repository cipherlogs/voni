import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  composeBrief,
  OUTCOME_SUGGESTIONS,
  resolveOutcomeReference,
} from "./starters";
import type { WizardDraft } from "./use-wizard-draft";

const EMPTY: WizardDraft = {
  outcomes: [],
  agentName: "",
  styleTraits: [],
  conversationLanguage: "en",
  voiceId: "anna",
};

test("outcome suggestions are the three fixed sentences", () => {
  assert.deepEqual(OUTCOME_SUGGESTIONS, [
    "Qualify property leads and book viewings",
    "Answer support questions after hours",
    "Confirm appointments and help reschedule",
  ]);
});

test("resolveOutcomeReference matches digits, words, ordinals, and #n", () => {
  assert.equal(resolveOutcomeReference("2"), OUTCOME_SUGGESTIONS[1]);
  assert.equal(resolveOutcomeReference("number two"), OUTCOME_SUGGESTIONS[1]);
  assert.equal(resolveOutcomeReference("Second"), OUTCOME_SUGGESTIONS[1]);
  assert.equal(resolveOutcomeReference("#3"), OUTCOME_SUGGESTIONS[2]);
  assert.equal(resolveOutcomeReference("  one  "), OUTCOME_SUGGESTIONS[0]);
  assert.equal(resolveOutcomeReference("first"), OUTCOME_SUGGESTIONS[0]);
  assert.equal(resolveOutcomeReference("THIRD"), OUTCOME_SUGGESTIONS[2]);
});

test("resolveOutcomeReference rejects non-references (raw typing stays text)", () => {
  for (const text of ["", "hello", "0", "12", "two please", "call it sara", "2a", "number"]) {
    assert.equal(resolveOutcomeReference(text), null, JSON.stringify(text));
  }
});

test("composeBrief joins outcomes, name, style, and language", () => {
  assert.equal(
    composeBrief(EMPTY),
    "It converses in English.",
  );
  assert.equal(
    composeBrief({ ...EMPTY, outcomes: ["  Qualify leads  "] }),
    "The agent must: Qualify leads. It converses in English.",
  );
  assert.equal(
    composeBrief({
      ...EMPTY,
      outcomes: ["Book viewings", "Answer questions"],
      agentName: "Sara",
      styleTraits: ["Friendly", "Calm"],
      conversationLanguage: "es",
    }),
    "The agent must: Book viewings; Answer questions. The agent is Sara. Conversational style: Friendly, Calm. It converses in Spanish.",
  );
});

test("composeBrief excludes voice (voice never reaches the LLM brief)", () => {
  const full = composeBrief({ ...EMPTY, outcomes: ["Book viewings"], voiceId: "giovanni" });
  assert.doesNotMatch(full, /giovanni/i);
});

// Regression guard: voni has no @testing-library/react / jsdom, so like
// wizard-timeline.test.tsx this asserts on the real step-body source text.
const stepBodiesSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "wizard-step-bodies.tsx"),
  "utf8",
);

test("OutcomesStep uses the shared TagField with the fixed heading", () => {
  assert.ok(stepBodiesSource.includes("What should your agent accomplish?"));
  assert.ok(stepBodiesSource.includes("Add one clear outcome per tag"));
  assert.ok(stepBodiesSource.includes("OUTCOME_SUGGESTIONS"));
  assert.ok(stepBodiesSource.includes("MAX_OUTCOMES"));
  assert.ok(stepBodiesSource.includes("MAX_OUTCOME_LENGTH"));
  assert.ok(!stepBodiesSource.includes("GoalStep"));
  assert.ok(!stepBodiesSource.includes("TasksStep"));
});

test("PersonalityStep orders name, style, language, voice with the style helper", () => {
  const body = stepBodiesSource.slice(stepBodiesSource.indexOf("export function PersonalityStep"));
  const nameAt = body.indexOf("-name");
  const styleAt = body.indexOf("Conversational style");
  const pickerAt = body.indexOf("ConversationPicker");
  assert.ok(nameAt !== -1 && styleAt !== -1 && pickerAt !== -1);
  assert.ok(nameAt < styleAt && styleAt < pickerAt);
  assert.ok(stepBodiesSource.includes("Shapes how the agent responds"));
  assert.ok(stepBodiesSource.includes("STYLE_SUGGESTIONS"));
  assert.ok(!stepBodiesSource.includes("speechSynthesis"));
  assert.ok(!stepBodiesSource.includes("Languages it listens for"));
});

test("ReviewStep shows outcomes, persona, language, voice with Edit jumps", () => {
  assert.ok(stepBodiesSource.includes('aria-label="Edit outcomes"'));
  assert.ok(stepBodiesSource.includes('aria-label="Edit persona"'));
  assert.ok(stepBodiesSource.includes("voiceLabel(draft.voiceId)"));
  assert.ok(!stepBodiesSource.includes("of 3 set"));
  assert.ok(!stepBodiesSource.includes("onUndo"));
  assert.ok(!stepBodiesSource.includes("undoLabel"));
  assert.ok(!stepBodiesSource.includes("MascotAvatar"));
});

test("wizard draft defaults to empty outcomes/name/style with English + anna", async () => {
  const { EMPTY_DRAFT } = await import("./use-wizard-draft");
  assert.deepEqual(EMPTY_DRAFT.outcomes, []);
  assert.equal(EMPTY_DRAFT.agentName, "");
  assert.deepEqual(EMPTY_DRAFT.styleTraits, []);
  assert.equal(EMPTY_DRAFT.conversationLanguage, "en");
  assert.equal(EMPTY_DRAFT.voiceId, "anna");
});

test("copilot voice/language summaries use the canonical phrases", async () => {
  const { wizardFieldSchema, wizardSummary } = await import(
    "@/lib/copilot/wizard-tools"
  );
  assert.equal(
    wizardFieldSchema.safeParse({ field: "voice", value: "anna" }).success,
    true,
  );
  assert.equal(
    wizardFieldSchema.safeParse({ field: "conversationLanguage", value: "es" }).success,
    true,
  );
  assert.equal(
    wizardFieldSchema.safeParse({ field: "outcomes", value: ["Qualify leads"] }).success,
    true,
  );
  assert.equal(wizardSummary("voice", "anna"), "Set voice to Anna");
  assert.equal(
    wizardSummary("conversationLanguage", "es"),
    "Set conversation language to es",
  );
});

test("agents/new save maps wizard voice and single language over the draft", () => {
  const pageSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../app/(dashboard)/agents/new/page.tsx"),
    "utf8",
  );
  assert.ok(pageSource.includes("voiceId: wiz.draft.voiceId"));
  assert.ok(pageSource.includes("languageCodes: [wiz.draft.conversationLanguage]"));
  assert.ok(
    pageSource.includes('enum: ["outcomes", "agentName", "styleTraits", "voice", "conversationLanguage"]'),
  );
});
