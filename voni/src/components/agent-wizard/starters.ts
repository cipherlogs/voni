import type { WizardDraft } from "./use-wizard-draft";

export type StarterDef = {
  /** Stable 1-based number shown on the card and resolved from voice. */
  number: number;
  title: string;
  /** One sentence previewing the resulting agent's work. */
  outcome: string;
  /** Goal text applied on tap. */
  goal: string;
  /** Task labels pre-checked on tap (must exist in TASK_CHIPS). */
  suggestTasks: string[];
};

/**
 * Shared starter definition: the cards, the applied patch, and voice
 * number resolution all read this one list, in this order, so "number
 * two" can never drift from what's on screen. No rotation, no categories.
 */
export const STARTER_DEFS: StarterDef[] = [
  {
    number: 1,
    title: "Book more property viewings",
    outcome: "Qualify interested leads and help arrange a viewing.",
    goal: "Qualify property leads and book viewings",
    suggestTasks: [
      "Ask for budget and timeline",
      "Offer two viewing slots",
      "Hand off to a human when stuck",
    ],
  },
  {
    number: 2,
    title: "Cover after-hours support",
    outcome: "Answer common questions and identify requests needing follow-up.",
    goal: "Answer support questions after hours",
    suggestTasks: ["Answer common questions directly", "Hand off to a human when stuck"],
  },
  {
    number: 3,
    title: "Confirm appointments",
    outcome: "Remind patients and identify who needs to reschedule.",
    goal: "Remind patients about appointments",
    suggestTasks: ["Confirm attendance or offer a new time", "Hand off to a human when stuck"],
  },
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
};

/** Maximum tasks on a draft (presets + custom combined). */
export const MAX_TASKS = 12;

/** Maximum characters for one custom task label. */
export const MAX_TASK_LENGTH = 140;

export type CustomTaskRejection = "empty" | "duplicate" | "too-long" | "capped";

export type CustomTaskResult =
  | { ok: true; tasks: string[] }
  | { ok: false; reason: CustomTaskRejection; message: string };

/**
 * Validate + append a custom task label. Pure so the step body and tests
 * share one rule: trim, case-insensitive dedup against all current tasks,
 * 140-char cap, 12-task cap. Never mutates `tasks`.
 */
export function addCustomTask(tasks: string[], raw: string): CustomTaskResult {
  const value = raw.trim();
  if (!value) {
    return { ok: false, reason: "empty", message: "Type a task first." };
  }
  if (value.length > MAX_TASK_LENGTH) {
    return {
      ok: false,
      reason: "too-long",
      message: `Keep tasks under ${MAX_TASK_LENGTH} characters.`,
    };
  }
  if (tasks.some((t) => t.toLowerCase() === value.toLowerCase())) {
    return { ok: false, reason: "duplicate", message: "That task is already added." };
  }
  if (tasks.length >= MAX_TASKS) {
    return {
      ok: false,
      reason: "capped",
      message: `Task limit reached (${MAX_TASKS}/${MAX_TASKS}). Remove one to add another.`,
    };
  }
  return { ok: true, tasks: [...tasks, value] };
}

/**
 * Resolve "number two" / "2" / "second" / "#2" against the starter list.
 * Only ever called on voice-heard lines and starter taps — never on raw
 * field typing, where "2" must stay the text "2".
 */
export function resolveStarterReference(text: string): StarterDef | null {
  const clean = text.trim().toLowerCase();
  const hash = clean.match(/^#([1-9])$/);
  if (hash) {
    return STARTER_DEFS.find((s) => s.number === Number(hash[1])) ?? null;
  }
  const num = clean.match(/^(?:number\s+)?([1-9])$/);
  if (num) {
    return STARTER_DEFS.find((s) => s.number === Number(num[1])) ?? null;
  }
  const word = clean.match(/^(?:number\s+)?(one|two|three|first|second|third)$/);
  if (word) {
    const n = NUMBER_WORDS[word[1]];
    return STARTER_DEFS.find((s) => s.number === n) ?? null;
  }
  return null;
}

/**
 * Compose the structured wizard draft into the plain-language brief the
 * existing agent_generation job consumes. Pure and unit-tested: the LLM
 * contract must not drift silently.
 */
export function composeBrief(draft: WizardDraft): string {
  const parts = [draft.goal.trim()];
  const who = [draft.agentName.trim(), draft.personality.trim()].filter(Boolean).join(", ");
  if (who) parts.push(`The agent is ${who}.`);
  const tasks = draft.tasks.map((t) => t.trim()).filter(Boolean);
  if (tasks.length > 0) parts.push(`It must: ${tasks.join("; ")}.`);
  return parts.filter(Boolean).join(" ");
}
