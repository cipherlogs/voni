import type { WizardDraft } from "./use-wizard-draft";
import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";
import { INPUT_LANGUAGES } from "@/lib/agents/voices";

/**
 * Goal suggestions: tapping one moves it up into the tag area (it leaves the
 * row below). Removing its tag moves it back down. No hidden starter tasks.
 */
export const GOAL_SUGGESTIONS: string[] = [
  "Qualify property leads and book viewings",
  "Answer support questions after hours",
  "Confirm appointments and help reschedule",
];

/** Task suggestions for the second group on the same step. */
export const TASK_SUGGESTIONS: string[] = [
  "Ask for budget and timeline",
  "Offer two viewing slots",
  "Answer common questions directly",
  "Confirm attendance or offer a new time",
  "Hand off to a human when stuck",
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
};

/**
 * Resolve "number two" / "2" / "second" / "#2" against the goal suggestion
 * list. Only ever called on voice-heard lines and suggestion taps — never on
 * raw field typing, where "2" must stay the text "2".
 */
export function resolveGoalReference(text: string): string | null {
  const clean = text.trim().toLowerCase();
  const hash = clean.match(/^#([1-9])$/);
  if (hash) {
    return GOAL_SUGGESTIONS[Number(hash[1]) - 1] ?? null;
  }
  const num = clean.match(/^(?:number\s+)?([1-9])$/);
  if (num) {
    return GOAL_SUGGESTIONS[Number(num[1]) - 1] ?? null;
  }
  const word = clean.match(/^(?:number\s+)?(one|two|three|first|second|third)$/);
  if (word) {
    const n = NUMBER_WORDS[word[1]];
    return GOAL_SUGGESTIONS[n - 1] ?? null;
  }
  return null;
}

function languageLabel(code: string): string {
  return (
    INPUT_LANGUAGES.find((l) => l.code === code)?.label ??
    CONVERSATION_LANGUAGES[0]
  );
}

/**
 * Compose the structured wizard draft into the plain-language brief the
 * existing agent_generation job consumes. Pure and unit-tested: the LLM
 * contract must not drift silently. Voice never reaches the brief — it is
 * applied deterministically after generation.
 */
export function composeBrief(draft: WizardDraft): string {
  const parts: string[] = [];
  const goals = draft.goals.map((t) => t.trim()).filter(Boolean);
  if (goals.length > 0) parts.push(`The agent must achieve: ${goals.join("; ")}.`);
  const tasks = draft.tasks.map((t) => t.trim()).filter(Boolean);
  if (tasks.length > 0) parts.push(`It must: ${tasks.join("; ")}.`);
  if (draft.agentName.trim()) parts.push(`The agent is ${draft.agentName.trim()}.`);
  const style = draft.styleTraits.map((t) => t.trim()).filter(Boolean);
  if (style.length > 0) parts.push(`Conversational style: ${style.join(", ")}.`);
  parts.push(`It converses in ${languageLabel(draft.conversationLanguage)}.`);
  return parts.join(" ");
}
