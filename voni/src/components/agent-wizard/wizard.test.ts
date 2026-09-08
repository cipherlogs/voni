import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addCustomTask,
  composeBrief,
  MAX_TASKS,
  MAX_TASK_LENGTH,
  resolveStarterReference,
  STARTER_DEFS,
} from "./starters";
import type { WizardDraft } from "./use-wizard-draft";
const EMPTY: WizardDraft = {
  goal: "",
  agentName: "",
  personality: "",
  tasks: [],
  voiceId: "anna",
  languageCodes: [],
};

test("starter definitions are stable, numbered 1-3, and task labels exist", () => {
  assert.deepEqual(
    STARTER_DEFS.map((s) => s.number),
    [1, 2, 3],
  );
  for (const starter of STARTER_DEFS) {
    assert.ok(starter.title.length > 0);
    assert.ok(starter.outcome.length > 0);
    assert.ok(starter.goal.length > 0);
    assert.ok(starter.suggestTasks.length > 0);
  }
});

test("resolveStarterReference matches digits, words, ordinals, and #n", () => {
  assert.equal(resolveStarterReference("2")?.number, 2);
  assert.equal(resolveStarterReference("number two")?.number, 2);
  assert.equal(resolveStarterReference("Second")?.number, 2);
  assert.equal(resolveStarterReference("#3")?.number, 3);
  assert.equal(resolveStarterReference("  one  ")?.number, 1);
  assert.equal(resolveStarterReference("first")?.number, 1);
  assert.equal(resolveStarterReference("THIRD")?.number, 3);
});

test("resolveStarterReference rejects non-references (raw typing stays text)", () => {
  for (const text of ["", "hello", "0", "12", "two please", "call it sara", "2a", "number"]) {
    assert.equal(resolveStarterReference(text), null, JSON.stringify(text));
  }
});

test("composeBrief joins goal, persona, and tasks; skips what is missing", () => {  assert.equal(composeBrief(EMPTY), "");
  assert.equal(composeBrief({ ...EMPTY, goal: "  Qualify leads  " }), "Qualify leads");
  assert.equal(
    composeBrief({
      ...EMPTY,
      goal: "Book viewings",
      agentName: "Sara",
      personality: "Friendly consultant",
      tasks: ["Ask for budget and timeline", "Hand off to a human when stuck"],
    }),
    "Book viewings The agent is Sara, Friendly consultant. It must: Ask for budget and timeline; Hand off to a human when stuck.",
  );
  assert.equal(
    composeBrief({ ...EMPTY, goal: "Book viewings", agentName: "", personality: "", tasks: [] }),
    "Book viewings",
  );
});

test("composeBrief passes custom task strings through unchanged", () => {
  assert.equal(
    composeBrief({
      ...EMPTY,
      goal: "Book viewings",
      tasks: ["Ask for preferred language", "Ask for budget and timeline"],
    }),
    "Book viewings It must: Ask for preferred language; Ask for budget and timeline.",
  );
});

test("composeBrief excludes voice and languages (voice never reaches the LLM brief)", () => {
  assert.equal(
    composeBrief({
      ...EMPTY,
      goal: "Book viewings",
      voiceId: "giovanni",
      languageCodes: ["ar", "es"],
    }),
    "Book viewings",
  );
  const full = composeBrief({
    ...EMPTY,
    goal: "Book viewings",
    agentName: "Sara",
    personality: "Friendly consultant",
    tasks: ["Ask for budget and timeline"],
    voiceId: "giovanni",
    languageCodes: ["ar"],
  });
  assert.doesNotMatch(full, /giovanni/i);
  assert.doesNotMatch(full, /\bar\b/);
});

test("addCustomTask trims and appends without mutating", () => {
  const prev = ["Ask for budget and timeline"];
  const result = addCustomTask(prev, "  Ask for preferred language  ");
  assert.equal(result.ok, true);
  assert.deepEqual(
    (result as { tasks: string[] }).tasks,
    ["Ask for budget and timeline", "Ask for preferred language"],
  );
  assert.deepEqual(prev, ["Ask for budget and timeline"]);
});

test("addCustomTask dedups case-insensitively", () => {
  const prev = ["Ask for Budget and Timeline"];
  for (const dup of ["ask for budget and timeline", "  ASK FOR BUDGET AND TIMELINE "]) {
    const result = addCustomTask(prev, dup);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "duplicate");
  }
});

test("addCustomTask rejects empty and too-long labels", () => {
  assert.equal((addCustomTask([], "   ") as { reason: string }).reason, "empty");
  assert.equal(
    (addCustomTask([], "x".repeat(MAX_TASK_LENGTH + 1)) as { reason: string }).reason,
    "too-long",
  );
  assert.equal(MAX_TASK_LENGTH, 140);
});

test("addCustomTask enforces the 12-task cap", () => {
  assert.equal(MAX_TASKS, 12);
  const full = Array.from({ length: MAX_TASKS }, (_, i) => `Task ${i + 1}`);
  const capped = addCustomTask(full, "One more");
  assert.equal(capped.ok, false);
  assert.equal((capped as { reason: string }).reason, "capped");
  assert.match((capped as { message: string }).message, /12\/12/);
  const room = addCustomTask(full.slice(0, MAX_TASKS - 1), "Last one");
  assert.equal(room.ok, true);
  assert.equal((room as { tasks: string[] }).tasks.length, MAX_TASKS);
});

// Task 7 regression guard: voni has no @testing-library/react / jsdom, so
// like wizard-timeline.test.tsx this asserts on the real step-body source
// text — the exact props/ids that ship to the DOM.
const stepBodiesSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "wizard-step-bodies.tsx"),
  "utf8",
);

test("GoalStep renders starters as compact chips with outcome tooltips", () => {
  assert.match(stepBodiesSource, /variant=\{applied \? "secondary" : "outline"\}/);
  assert.match(stepBodiesSource, /title=\{starter\.outcome\}/);
  assert.match(stepBodiesSource, /aria-describedby=\{descId\}/);
  assert.match(stepBodiesSource, /id=\{descId\} className="sr-only"/);
  assert.match(stepBodiesSource, /Or describe your own goal/);
  assert.match(
    stepBodiesSource,
    /api\.edit\(\{ goal: starter\.goal, tasks \}, `starter /,
  );
});

test("TasksStep supports custom tasks with caps and removal", () => {
  assert.match(stepBodiesSource, /id=\{`\$\{idPrefix\}-custom-task`\}/);
  assert.match(stepBodiesSource, /aria-label=\{`Remove \$\{task\}`\}/);
  assert.match(stepBodiesSource, /\{taskCount\}\/\{MAX_TASKS\}/);
  assert.match(stepBodiesSource, /maxLength=\{MAX_TASK_LENGTH\}/);
  assert.match(stepBodiesSource, /addCustomTask\(api\.draft\.tasks, customValue\)/);
  assert.match(stepBodiesSource, /api\.edit\(\{ tasks: result\.tasks \}, "custom task add"\)/);
  assert.match(stepBodiesSource, /"custom task remove"/);
});

// Task 8: personality voice + language + TTS sample. Component render tests
// are source-text guards per the T7 precedent (no jsdom in this repo);
// behavior (brief exclusion, schema, rate limit) is covered by pure-function
// tests on the exact helpers the components and route call.
test("wizard draft defaults to anna with no pinned languages", async () => {
  const { EMPTY_DRAFT } = await import("./use-wizard-draft");
  assert.equal(EMPTY_DRAFT.voiceId, "anna");
  assert.deepEqual(EMPTY_DRAFT.languageCodes, []);
  assert.equal(EMPTY_DRAFT.goal, "");
  assert.deepEqual(EMPTY_DRAFT.tasks, []);
});

test("copilot voice/language summaries use the canonical phrases", async () => {
  const { wizardFieldSchema, wizardSummary } = await import(
    "@/lib/copilot/wizard-tools"
  );
  assert.equal(wizardFieldSchema.safeParse({ field: "voice", value: "anna" }).success, true);
  assert.equal(
    wizardFieldSchema.safeParse({ field: "languages", value: ["ar", "es"] }).success,
    true,
  );
  assert.equal(wizardSummary("voice", "anna"), "Set voice to Anna");
  assert.equal(wizardSummary("languages", ["ar", "es"]), "Listen for ar; es");
  // T7 custom-task handling preserved: free values still validate.
  assert.equal(
    wizardFieldSchema.safeParse({ field: "tasks", value: ["Ask for preferred language"] })
      .success,
    true,
  );
});

test("PersonalityStep reuses the review-form voice/language sources with Play samples", () => {
  assert.match(stepBodiesSource, /voicesByLanguage\(\)/);
  assert.match(stepBodiesSource, /voiceLabel\(voice\.id\)/);
  assert.match(stepBodiesSource, /ACCENT_LABEL\[voice\.accent\]/);
  assert.match(stepBodiesSource, /INPUT_LANGUAGES\.map/);
  assert.match(stepBodiesSource, /understands only/);
  assert.match(stepBodiesSource, /aria-label=\{\s*loading/);
  assert.match(stepBodiesSource, /`Preview \$\{voiceLabel\(voice\.id\)\}`/);
  assert.match(stepBodiesSource, /h-7 w-7 cursor-pointer p-0/);
  assert.match(stepBodiesSource, /api\.edit\(\{ voiceId: voice\.id \}, "voice change"\)/);
  // Explicit Play only: samples start in the tap handler, never on select,
  // and speech is cancelled on switch and on unmount.
  assert.match(stepBodiesSource, /\.speak\(utter\)/);
  assert.match(stepBodiesSource, /speechSynthesis\.cancel\(\)/);
  assert.match(stepBodiesSource, /stopPreview\(\)/);
  // 429 countdown copy matches the voice-call pattern.
  assert.match(stepBodiesSource, /Too many previews right now — try again in/);
  assert.match(stepBodiesSource, /You can try again now\./);
  // Missing-key path links Settings.
  assert.match(stepBodiesSource, /href="\/settings"/);
});

test("ReviewStep persona row shows name, personality, and voice label", () => {
  assert.match(stepBodiesSource, /personaText\} · \{voiceLabel\(draft\.voiceId\)\}/);
  assert.match(stepBodiesSource, /flashed === "voice"/);
  assert.match(stepBodiesSource, /flashed === "languages"/);
});

test("agents/new save maps wizard voice and languages over the generated draft", () => {
  const pageSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../app/(dashboard)/agents/new/page.tsx"),
    "utf8",
  );
  assert.match(pageSource, /voiceId: wiz\.draft\.voiceId/);
  assert.match(pageSource, /languageCodes: \[\.\.\.wiz\.draft\.languageCodes\]/);
  assert.match(
    pageSource,
    /enum: \["goal", "agentName", "personality", "tasks", "voice", "languages"\]/,
  );
});
