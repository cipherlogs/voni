/**
 * Wizard tool bindings: schemas, summaries, executors, target readers.
 *
 * One propose tool (`wizard_propose_change`) keeps the session tool list
 * small; the field enum routes to the right patch. Summaries are canonical —
 * the agent reads them back verbatim and the readback matcher binds on the
 * key phrases derived from the same source.
 *
 * Transport bounds here are intentionally loose; the shared field limits
 * (outcomes 12×140, style 5×60, name 120, voice∈language) are enforced in
 * `resolveWizardValue` (propose time, against the live draft) and re-checked
 * in the executor — so voice can never create values the UI cannot represent.
 */

import { z } from "zod";
import type { Executor, TargetSnapshot } from "./bus";
import type { FlashKey, WizardDraft } from "@/components/agent-wizard/use-wizard-draft";
import { getVoice, voiceLabel } from "@/lib/agents/voices";
import { INPUT_LANGUAGES } from "@/lib/agents/voices";
import {
  MAX_AGENT_NAME_LENGTH,
  MAX_OUTCOME_LENGTH,
  MAX_OUTCOMES,
  MAX_STYLE_LENGTH,
  MAX_STYLE_TRAITS,
  normalizeTag,
  voiceForLanguage,
  type ConversationLanguage,
} from "@/lib/agents/wizard";

export const wizardFieldSchema = z.object({
  field: z.enum(["outcomes", "agentName", "styleTraits", "voice", "conversationLanguage"]),
  value: z.union([z.string().trim().min(1).max(2000), z.array(z.string().trim().min(1).max(200)).min(1).max(20)]),
});

export type WizardField = z.infer<typeof wizardFieldSchema>["field"];

export type ResolvedWizardValue =
  | { ok: true; patch: Partial<WizardDraft>; touched: Exclude<FlashKey, null>[]; summary: string }
  | { ok: false; error: string };

const FIELD_LABEL: Record<WizardField, string> = {
  outcomes: "outcomes",
  agentName: "agent name",
  styleTraits: "conversational style",
  voice: "voice",
  conversationLanguage: "conversation language",
};

function toArray(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value]).map(normalizeTag).filter(Boolean);
}

function deduped(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve a spoken operation to a complete validated target value against the
 * live draft, before anything is proposed. Language and voice always resolve
 * as a pair so the two can never mismatch.
 */
export function resolveWizardValue(
  field: WizardField,
  value: string | string[],
  draft: WizardDraft,
): ResolvedWizardValue {
  if (field === "outcomes") {
    const items = deduped(toArray(value));
    if (items.length === 0) return { ok: false, error: "Say at least one outcome." };
    if (items.length > MAX_OUTCOMES) {
      return { ok: false, error: `Keep it to ${MAX_OUTCOMES} outcomes.` };
    }
    if (items.some((v) => v.length > MAX_OUTCOME_LENGTH)) {
      return { ok: false, error: `Keep outcomes under ${MAX_OUTCOME_LENGTH} characters.` };
    }
    return {
      ok: true,
      patch: { outcomes: items },
      touched: ["outcomes"],
      summary: `Set outcomes to ${items.join("; ")}`,
    };
  }
  if (field === "agentName") {
    const name = normalizeTag(Array.isArray(value) ? value.join(" ") : value);
    if (!name) return { ok: false, error: "Say the agent's name." };
    if (name.length > MAX_AGENT_NAME_LENGTH) {
      return { ok: false, error: `Keep names under ${MAX_AGENT_NAME_LENGTH} characters.` };
    }
    return {
      ok: true,
      patch: { agentName: name },
      touched: ["agentName"],
      summary: `Set the agent name to ${name}`,
    };
  }
  if (field === "styleTraits") {
    const items = deduped(toArray(value));
    if (items.length > MAX_STYLE_TRAITS) {
      return { ok: false, error: `Keep it to ${MAX_STYLE_TRAITS} style tags.` };
    }
    if (items.some((v) => v.length > MAX_STYLE_LENGTH)) {
      return { ok: false, error: `Keep style tags under ${MAX_STYLE_LENGTH} characters.` };
    }
    return {
      ok: true,
      patch: { styleTraits: items },
      touched: ["styleTraits"],
      summary:
        items.length > 0
          ? `Set conversational style to ${items.join(", ")}`
          : "Clear the conversational style",
    };
  }
  if (field === "voice") {
    if (Array.isArray(value)) return { ok: false, error: "Say one voice name." };
    const voice = getVoice(normalizeTag(value).toLowerCase());
    if (!voice) return { ok: false, error: "Say which voice to use." };
    return {
      ok: true,
      patch: { voiceId: voice.id, conversationLanguage: voice.languageCode as ConversationLanguage },
      touched: ["voice", "conversationLanguage"],
      summary: `Set voice to ${voiceLabel(voice.id)}`,
    };
  }
  // conversationLanguage: resolve the pair together.
  if (Array.isArray(value)) return { ok: false, error: "Say one language." };
  const code = normalizeTag(value).toLowerCase() as ConversationLanguage;
  const supported: ConversationLanguage[] = ["en", "es", "fr", "de", "it", "pt"];
  if (!supported.includes(code)) {
    return { ok: false, error: "Say which conversation language to use." };
  }
  const pair = voiceForLanguage(code, draft.voiceId);
  const languageName = INPUT_LANGUAGES.find((l) => l.code === code)?.label ?? code;
  return {
    ok: true,
    patch: pair.changed
      ? { conversationLanguage: code, voiceId: pair.voiceId }
      : { conversationLanguage: code },
    touched: pair.changed ? ["conversationLanguage", "voice"] : ["conversationLanguage"],
    summary: pair.changed
      ? `Set conversation language to ${languageName} with ${voiceLabel(pair.voiceId)}`
      : `Set conversation language to ${languageName}`,
  };
}

function formatValue(field: WizardField, value: string | string[]): string {
  return Array.isArray(value) ? value.join("; ") : value;
}

export function wizardSummary(field: WizardField, value: string | string[]): string {
  if (field === "voice" && !Array.isArray(value)) {
    return `Set voice to ${voiceLabel(value)}`;
  }
  if (field === "conversationLanguage") {
    return `Set conversation language to ${formatValue(field, value)}`;
  }
  return `Set ${FIELD_LABEL[field]} to ${formatValue(field, value)}`;
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
  const reader = (key: keyof WizardDraft) => () => {
    const value = getDraft()[key];
    return { value, version: fieldVersion(value) };
  };
  return new Map([
    ["wizard:outcomes", reader("outcomes")],
    ["wizard:agentName", reader("agentName")],
    ["wizard:styleTraits", reader("styleTraits")],
    ["wizard:voice", reader("voiceId")],
    ["wizard:conversationLanguage", reader("conversationLanguage")],
  ]);
}

/**
 * Executor factory. `apply` is the wizard store's applyAgentPatch: history,
 * flash, and Undo arming come from the existing store, so voice patches are
 * indistinguishable from (and as reversible as) any other agent patch.
 * Payloads must be resolved values (see resolveWizardValue); the executor
 * re-checks the shared limits and fails closed on anything else.
 */
export function createWizardExecutor(
  apply: (
    patch: Partial<WizardDraft>,
    touched: Exclude<FlashKey, null>[],
    label: string,
  ) => void,
  getDraft?: () => WizardDraft,
): Executor {
  return async (payload) => {
    const parsed = wizardFieldSchema.safeParse(payload);
    if (!parsed.success) {
      return { result: {}, uncertain: true, uncertaintyReason: "Payload failed validation." };
    }
    const { field, value } = parsed.data;
    if (field === "outcomes") {
      const items = deduped(toArray(value));
      if (
        items.length === 0 ||
        items.length > MAX_OUTCOMES ||
        items.some((v) => v.length > MAX_OUTCOME_LENGTH)
      ) {
        return { result: {}, uncertain: true, uncertaintyReason: "Outcomes failed validation." };
      }
      apply({ outcomes: items }, ["outcomes"], `voice: ${field}`);
      return { result: { applied: field }, resultingVersion: fieldVersion(items) };
    }
    if (field === "agentName") {
      const name = normalizeTag(Array.isArray(value) ? value.join(" ") : value);
      if (!name || name.length > MAX_AGENT_NAME_LENGTH) {
        return { result: {}, uncertain: true, uncertaintyReason: "Name failed validation." };
      }
      apply({ agentName: name }, ["agentName"], `voice: ${field}`);
      return { result: { applied: field }, resultingVersion: fieldVersion(name) };
    }
    if (field === "styleTraits") {
      const items = deduped(toArray(value));
      if (
        items.length > MAX_STYLE_TRAITS ||
        items.some((v) => v.length > MAX_STYLE_LENGTH)
      ) {
        return { result: {}, uncertain: true, uncertaintyReason: "Style failed validation." };
      }
      apply({ styleTraits: items }, ["styleTraits"], `voice: ${field}`);
      return { result: { applied: field }, resultingVersion: fieldVersion(items) };
    }
    if (field === "voice") {
      if (Array.isArray(value)) {
        return { result: {}, uncertain: true, uncertaintyReason: "Say one voice name." };
      }
      const voice = getVoice(normalizeTag(value).toLowerCase());
      if (!voice) {
        return { result: {}, uncertain: true, uncertaintyReason: "Unknown voice." };
      }
      apply(
        { voiceId: voice.id, conversationLanguage: voice.languageCode as ConversationLanguage },
        ["voice", "conversationLanguage"],
        `voice: ${field}`,
      );
      return { result: { applied: field }, resultingVersion: fieldVersion(voice.id) };
    }
    if (Array.isArray(value)) {
      return { result: {}, uncertain: true, uncertaintyReason: "Say one language." };
    }
    const supported: ConversationLanguage[] = ["en", "es", "fr", "de", "it", "pt"];
    const code = normalizeTag(value).toLowerCase() as ConversationLanguage;
    if (!supported.includes(code)) {
      return { result: {}, uncertain: true, uncertaintyReason: "Unsupported language." };
    }
    const pair = voiceForLanguage(code, getDraft?.().voiceId);
    const patch: Partial<WizardDraft> = pair.changed
      ? { conversationLanguage: code, voiceId: pair.voiceId }
      : { conversationLanguage: code };
    const touched: Exclude<FlashKey, null>[] = pair.changed
      ? ["conversationLanguage", "voice"]
      : ["conversationLanguage"];
    apply(patch, touched, `voice: ${field}`);
    return { result: { applied: field }, resultingVersion: fieldVersion(code) };
  };
}
