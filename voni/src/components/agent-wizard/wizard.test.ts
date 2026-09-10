import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  composeBrief,
  generationIdempotencyKey,
  GOAL_SUGGESTIONS,
  resolveGoalReference,
  TASK_SUGGESTIONS,
} from "./starters";
import type { WizardDraft } from "./use-wizard-draft";
import { parseWizardDraftCache } from "./use-wizard-draft";

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

test("working phase shows the submitted panel: mini success, progress, safe-to-leave", () => {
  // The click must prove it landed instantly, say what is happening, and
  // answer "can I go?" — before the 3s background threshold fires.
  assert.ok(stepBodiesSource.includes("GenerationSubmitted"));
  const noticeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "./generation-notice.tsx"),
    "utf8",
  );
  assert.ok(noticeSource.includes("Brief received"));
  assert.ok(noticeSource.includes("Safe to leave"));
  assert.ok(noticeSource.includes("Open Jobs"));
  assert.ok(noticeSource.includes('aria-label="Generation in progress"'));
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

test("agents/new review saves as shown — voice folds at result, save is verbatim", () => {
  const pageSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../app/(dashboard)/agents/new/page.tsx"),
    "utf8",
  );
  // The wizard's voice + language fold into the review draft when the result
  // lands (submit-time echo wins, live draft covers brief-only jobs), so the
  // reviewed config is the saved config — no silent overwrite in save().
  assert.ok(pageSource.includes("languageCodes: [conversationLanguage]"));
  assert.ok(pageSource.includes("createAgentAction(name, config, {"));
  // The old save-time overwrite is gone (the remaining wiz.draft.voiceId
  // reference is the placeholder snapshot, not the save path).
  assert.ok(!pageSource.includes("const merged: AgentConfig"));
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
  // The job pointer survives in the URL: a reload re-attaches via the ?job=
  // restore path instead of orphaning the job. Start over strips it (with a
  // dismissed-job guard covering the render window before the strip lands)
  // so the cleared review can't re-seed from the same job.
  assert.ok(pageSource.includes("router.replace(`/agents/new?job=${started.jobId}`)"));
  assert.ok(pageSource.includes('router.replace("/agents/new")'));
  assert.ok(pageSource.includes("dismissedJobId"));
  // While a fresh submission runs, the form hides behind the submitted
  // panel (locked until terminal) and the footer action goes away.
  assert.ok(pageSource.includes("submitting"));
  assert.ok(pageSource.includes("wiz.step === 1 && !submitting"));
  assert.ok(pageSource.includes("submitting ? null : wiz.step === 0 ?"));
  // Generate creates the list placeholder up front (best-effort); saving
  // upgrades it by job id so ?job= restores don't twin the row.
  assert.ok(pageSource.includes("ensureGenerationPlaceholderAction"));
  assert.ok(pageSource.includes("generationJobId: generation.jobId ?? restoreJobId"));
  // ?job= returns reseed the wizard from the placeholder (gated so review
  // mounts with the name/voice/language intact), falling back to the
  // generated identity name when there is no placeholder.
  assert.ok(pageSource.includes("getGenerationPlaceholderAction"));
  assert.ok(pageSource.includes("if (draft && seeded)"));
  assert.ok(pageSource.includes("wiz.draft.agentName || draft.identity.name"));
  // Failed restores jump to step 1 so the error is seen, not stranded.
  assert.ok(pageSource.includes('wiz.setStep(1);'));
  // Seeding is unconditional: the job watcher routinely settles first (its
  // first poll already sees a terminal job), which runs effect cleanup — a
  // cancelled-guarded setSeeded would leave `seeded` false forever and hide
  // a ready review behind the wizard.
  assert.ok(!pageSource.includes("if (!cancelled) setSeeded(true)"));
  // The loading skeleton mirrors the real creator shape, not bare text.
  assert.ok(pageSource.includes("NewAgentSkeleton"));
});

test("generationIdempotencyKey is stable per brief, distinct across briefs", () => {
  const brief = composeBrief({ ...EMPTY, goals: ["Qualify leads"] });
  assert.equal(generationIdempotencyKey(brief), generationIdempotencyKey(brief));
  assert.ok(generationIdempotencyKey(brief).startsWith("generation:"));
  const other = composeBrief({ ...EMPTY, goals: ["Answer support questions"] });
  assert.notEqual(generationIdempotencyKey(brief), generationIdempotencyKey(other));
});

test("parseWizardDraftCache accepts full shapes, rejects corrupt ones", () => {
  const full = JSON.stringify({
    draft: { ...EMPTY, goals: ["Book viewings"], step: undefined },
    step: 1,
  });
  const parsed = parseWizardDraftCache(full);
  assert.ok(parsed);
  assert.deepEqual(parsed.draft.goals, ["Book viewings"]);
  assert.equal(parsed.step, 1);
  // Missing step defaults are tolerated by the hook; the parser keeps them.
  assert.ok(parseWizardDraftCache(JSON.stringify({ draft: { ...EMPTY } })));
  for (const bad of [
    null,
    "",
    "{not json",
    "{}",
    JSON.stringify({ draft: null }),
    JSON.stringify({ draft: { ...EMPTY, goals: "nope" } }),
    JSON.stringify({ draft: { ...EMPTY, conversationLanguage: "xx" } }),
    JSON.stringify({ draft: { ...EMPTY, agentName: 42 } }),
  ]) {
    assert.equal(parseWizardDraftCache(bad), null, String(bad)?.slice(0, 60));
  }
});

test("agents/new submits wizardDraft + stable key; processor echoes; guard dedupes", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const pageSource = readFileSync(
    join(dir, "../../app/(dashboard)/agents/new/page.tsx"),
    "utf8",
  );
  // Submit carries the structured snapshot plus a stable idempotency key.
  assert.ok(pageSource.includes("wizardDraft: {"));
  assert.ok(pageSource.includes("idempotencyKey: generationIdempotencyKey(brief)"));
  // Processor echoes the snapshot for placeholder-less ?job= restores.
  const processorSource = readFileSync(
    join(dir, "../../lib/jobs/processors/generation.ts"),
    "utf8",
  );
  assert.ok(processorSource.includes("input.wizardDraft"));
  // A second submit mid-flight returns the running job (created=false),
  // which the existing "already running" toast already covers.
  const startSource = readFileSync(join(dir, "../../lib/jobs/start.ts"), "utf8");
  assert.ok(startSource.includes('kind === "agent_generation"'));
  assert.ok(startSource.includes('"agent_generation",'));
});

test("wizard footer is static flow — no stuck overlay, no reserve hack", () => {
  const pageSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../app/(dashboard)/agents/new/page.tsx"),
    "utf8",
  );
  assert.ok(!pageSource.includes("pb-[calc"));
  assert.ok(!pageSource.includes("--job-pill-h"));
});
