import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  composeBrief,
  GOAL_SUGGESTIONS,
  resolveGoalReference,
  TASK_SUGGESTIONS,
} from "./starters";
import type { WizardDraft } from "./use-wizard-draft";

const EMPTY: WizardDraft = {
  goals: [],
  tasks: [],
  agentName: "",
  styleTraits: [],
  conversationLanguage: "en",
  voiceId: "anna",
};

test("goal suggestions are the three fixed sentences; tasks have five", () => {
  assert.deepEqual(GOAL_SUGGESTIONS, [
    "Qualify property leads and book viewings",
    "Answer support questions after hours",
    "Confirm appointments and help reschedule",
  ]);
  assert.equal(TASK_SUGGESTIONS.length, 5);
});

test("resolveGoalReference matches digits, words, ordinals, and #n", () => {
  assert.equal(resolveGoalReference("2"), GOAL_SUGGESTIONS[1]);
  assert.equal(resolveGoalReference("number two"), GOAL_SUGGESTIONS[1]);
  assert.equal(resolveGoalReference("Second"), GOAL_SUGGESTIONS[1]);
  assert.equal(resolveGoalReference("#3"), GOAL_SUGGESTIONS[2]);
  assert.equal(resolveGoalReference("  one  "), GOAL_SUGGESTIONS[0]);
  assert.equal(resolveGoalReference("first"), GOAL_SUGGESTIONS[0]);
  assert.equal(resolveGoalReference("THIRD"), GOAL_SUGGESTIONS[2]);
});

test("resolveGoalReference rejects non-references (raw typing stays text)", () => {
  for (const text of ["", "hello", "0", "12", "two please", "call it sara", "2a", "number"]) {
    assert.equal(resolveGoalReference(text), null, JSON.stringify(text));
  }
});

test("composeBrief joins goals, tasks, name, style, and language", () => {
  assert.equal(
    composeBrief(EMPTY),
    "It converses in English.",
  );
  assert.equal(
    composeBrief({ ...EMPTY, goals: ["  Qualify leads  "] }),
    "The agent must achieve: Qualify leads. It converses in English.",
  );
  assert.equal(
    composeBrief({
      ...EMPTY,
      goals: ["Book viewings", "Answer questions"],
      tasks: ["Ask for budget"],
      agentName: "Sara",
      styleTraits: ["Friendly", "Calm"],
      conversationLanguage: "es",
    }),
    "The agent must achieve: Book viewings; Answer questions. It must: Ask for budget. The agent is Sara. Conversational style: Friendly, Calm. It converses in Spanish.",
  );
});

test("composeBrief excludes voice (voice never reaches the LLM brief)", () => {
  const full = composeBrief({ ...EMPTY, goals: ["Book viewings"], voiceId: "giovanni" });
  assert.doesNotMatch(full, /giovanni/i);
});

// Regression guard: voni has no @testing-library/react / jsdom, so like
// wizard-timeline.test.tsx this asserts on the real step-body source text.
const stepBodiesSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "wizard-step-bodies.tsx"),
  "utf8",
);

test("PlanStep keeps Goals and Tasks visibly separated on one step", () => {
  assert.ok(stepBodiesSource.includes("What should your agent do?"));
  assert.ok(stepBodiesSource.includes("GOAL_SUGGESTIONS"));
  assert.ok(stepBodiesSource.includes("TASK_SUGGESTIONS"));
  assert.ok(stepBodiesSource.includes("MAX_GOALS"));
  assert.ok(stepBodiesSource.includes("MAX_TASKS"));
  assert.ok(stepBodiesSource.includes("outcome that must happen"));
  assert.ok(stepBodiesSource.includes("Short directions"));
  const goalsAt = stepBodiesSource.indexOf('label="1 · Goals"');
  const tasksAt = stepBodiesSource.indexOf('label="2 · Tasks"');
  assert.ok(goalsAt !== -1 && tasksAt !== -1 && goalsAt < tasksAt);
  assert.ok(!stepBodiesSource.includes("OutcomesStep"));
});

test("Name errors render inline under the field in a reserved slot", () => {
  assert.ok(stepBodiesSource.includes("nameError"));
  assert.ok(stepBodiesSource.includes("min-h-5"));
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
  assert.ok(stepBodiesSource.includes("max-w-sm"));
  assert.ok(!stepBodiesSource.includes("speechSynthesis"));
  assert.ok(!stepBodiesSource.includes("Languages it listens for"));
});

test("ReviewStep is gone; generation status renders in-flow", () => {
  assert.ok(!stepBodiesSource.includes("ReviewStep"));
  assert.ok(!stepBodiesSource.includes("Edit goals"));
  assert.ok(stepBodiesSource.includes("GenerationStatus"));
  assert.ok(stepBodiesSource.includes("Use the real estate template"));
  assert.ok(!stepBodiesSource.includes("MascotAvatar"));
});

test("wizard draft defaults to empty goals/tasks with English + anna", async () => {
  const { EMPTY_DRAFT } = await import("./use-wizard-draft");
  assert.deepEqual(EMPTY_DRAFT.goals, []);
  assert.deepEqual(EMPTY_DRAFT.tasks, []);
  assert.equal(EMPTY_DRAFT.agentName, "");
  assert.deepEqual(EMPTY_DRAFT.styleTraits, []);
  assert.equal(EMPTY_DRAFT.conversationLanguage, "en");
  assert.equal(EMPTY_DRAFT.voiceId, "anna");
});

test("copilot goal/task summaries use the canonical phrases", async () => {
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
    wizardFieldSchema.safeParse({ field: "goals", value: ["Qualify leads"] }).success,
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
    pageSource.includes('enum: ["goals", "tasks", "agentName", "styleTraits", "voice", "conversationLanguage"]'),
  );
});

test("agents/new generates and reviews in place — never navigates to a draft", () => {
  const pageSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../app/(dashboard)/agents/new/page.tsx"),
    "utf8",
  );
  // Generation stays in the wizard: inline progress, then review on this
  // page, then Save. No draft row is created up front.
  assert.ok(!pageSource.includes("createDraftAgentAction"));
  assert.ok(!pageSource.includes("pendingAgentId"));
  assert.ok(pageSource.includes('router.replace("/agents/new")'));
  // The loading skeleton mirrors the real creator shape, not bare text.
  assert.ok(pageSource.includes("NewAgentSkeleton"));
});

test("wizard footer is static flow — no stuck overlay, no reserve hack", () => {
  const pageSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../app/(dashboard)/agents/new/page.tsx"),
    "utf8",
  );
  assert.ok(!pageSource.includes("pb-[calc"));
  assert.ok(!pageSource.includes("--job-pill-h"));
});
