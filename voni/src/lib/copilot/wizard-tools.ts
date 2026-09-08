/**
 * Wizard tool bindings: schemas, summaries, executors, target readers.
 *
 * One propose tool (`wizard_propose_change`) keeps the session tool list
 * small; the field enum routes to the right patch. Summaries are canonical —
 * the agent reads them back verbatim and the readback matcher binds on the
 * key phrases derived from the same source.
 */

import { z } from "zod";
import type { Executor, TargetSnapshot } from "./bus";
import type { FlashKey, WizardDraft } from "@/components/agent-wizard/use-wizard-draft";
import { voiceLabel } from "@/lib/agents/voices";

export const wizardFieldSchema = z.object({
  // NOTE: the tasks array bound (≤20 × ≤200) is intentionally wider than the
  // step UI cap (12 × 140, see starters.ts MAX_TASKS/MAX_TASK_LENGTH). Voice
  // can set state the UI cannot reproduce; the step shows N/12 + the cap
  // message and blocks further adds until one is removed. Do not "fix" this
  // by widening the UI cap or narrowing the schema without both owners.
  field: z.enum(["goal", "agentName", "personality", "tasks", "voice", "languages"]),
  value: z.union([z.string().trim().min(1).max(2000), z.array(z.string().trim().min(1).max(200)).min(1).max(20)]),
});

export type WizardField = z.infer<typeof wizardFieldSchema>["field"];

const FIELD_LABEL: Record<WizardField, string> = {
  goal: "goal",
  agentName: "agent name",
  personality: "personality",
  tasks: "tasks",
  voice: "voice",
  languages: "languages",
};

function formatValue(field: WizardField, value: string | string[]): string {
  return Array.isArray(value) ? value.join("; ") : value;
}

export function wizardSummary(field: WizardField, value: string | string[]): string {
  if (field === "voice" && !Array.isArray(value)) {
    return `Set voice to ${voiceLabel(value)}`;
  }
  if (field === "languages") {
    return `Listen for ${formatValue(field, value)}`;
  }
  return `Set the ${FIELD_LABEL[field]} to ${formatValue(field, value)}`;
}

export function wizardKeyPhrases(field: WizardField, value: string | string[]): string[] {
  const label = FIELD_LABEL[field];
  if (Array.isArray(value)) {
    return [label, ...value.slice(0, 3)];
  }
  const words = value.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return [label, words];
}

function fieldVersion(value: unknown): string {
  return JSON.stringify(value);
}

export function createWizardTargetReader(
  getDraft: () => WizardDraft,
): Map<string, () => TargetSnapshot | null> {
  // Copilot field names ("voice", "languages") differ from draft keys
  // ("voiceId", "languageCodes") — map explicitly so a rename on either side
  // fails here, loudly, instead of reading `undefined` silently.
  const FIELD_TO_DRAFT_KEY: Record<WizardField, keyof WizardDraft> = {
    goal: "goal",
    agentName: "agentName",
    personality: "personality",
    tasks: "tasks",
    voice: "voiceId",
    languages: "languageCodes",
  };
  const reader = (field: WizardField) => () => {
    const value = getDraft()[FIELD_TO_DRAFT_KEY[field]];
    return { value, version: fieldVersion(value) };
  };
  return new Map([
    ["wizard:goal", reader("goal")],
    ["wizard:agentName", reader("agentName")],
    ["wizard:personality", reader("personality")],
    ["wizard:tasks", reader("tasks")],
    ["wizard:voice", reader("voice")],
    ["wizard:languages", reader("languages")],
  ]);
}

/**
 * Executor factory. `apply` is the wizard store's applyAgentPatch: history,
 * flash, and Undo arming come from the existing store, so voice patches are
 * indistinguishable from (and as reversible as) any other agent patch.
 */
export function createWizardExecutor(
  apply: (
    patch: Partial<WizardDraft>,
    touched: Exclude<FlashKey, null>[],
    label: string,
  ) => void,
): Executor {
  return async (payload) => {
    const parsed = wizardFieldSchema.safeParse(payload);
    if (!parsed.success) {
      return { result: {}, uncertain: true, uncertaintyReason: "Payload failed validation." };
    }
    const { field, value } = parsed.data;
    const key: keyof WizardDraft =
      field === "voice" ? "voiceId" : field === "languages" ? "languageCodes" : field;
    apply({ [key]: value } as Partial<WizardDraft>, [field], `voice: ${field}`);
    return {
      result: { applied: field },
      resultingVersion: fieldVersion(value),
    };
  };
}
