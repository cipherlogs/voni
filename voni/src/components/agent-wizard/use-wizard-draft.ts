"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationLanguage } from "@/lib/agents/wizard";
import {
  DEFAULT_CONVERSATION_LANGUAGE,
  DEFAULT_WIZARD_VOICE_ID,
} from "@/lib/agents/wizard";

export const WIZARD_STEPS = ["Outcomes", "Personality", "Review"] as const;

/** The single source of truth both the user's mouse and the guide edit. */
export type WizardDraft = {
  outcomes: string[];
  agentName: string;
  styleTraits: string[];
  conversationLanguage: ConversationLanguage;
  /** AssemblyAI voice catalog id. `anna` is the one validated on real calls. */
  voiceId: string;
};

export const EMPTY_DRAFT: WizardDraft = {
  outcomes: [],
  agentName: "",
  styleTraits: [],
  conversationLanguage: DEFAULT_CONVERSATION_LANGUAGE,
  voiceId: DEFAULT_WIZARD_VOICE_ID,
};

/** Field keys the guide can flash when it applies a patch. */
export type FlashKey =
  | "outcomes"
  | "agentName"
  | "styleTraits"
  | "voice"
  | "conversationLanguage"
  | null;

const MAX_HISTORY = 20;

/**
 * Shared wizard state: one draft, step position, per-field flash, and a
 * snapshot history so every agent patch — and every user edit — is undoable
 * internally (the visible Review undo button is gone; voice undo remains).
 */
export function useWizardDraft() {
  const [draft, setDraft] = useState<WizardDraft>(EMPTY_DRAFT);
  /** Ref mirror so delayed callbacks (voice patches) resolve against the
   * latest draft instead of a send-time snapshot. */
  const draftRef = useRef<WizardDraft>(EMPTY_DRAFT);
  const [step, setStep] = useState(0);
  const [flashed, setFlashed] = useState<FlashKey>(null);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);
  const [historyLen, setHistoryLen] = useState(0);
  const history = useRef<WizardDraft[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const flash = useCallback(
    (key: Exclude<FlashKey, null>) => {
      setFlashed(key);
      later(() => setFlashed(null), 900);
    },
    [later],
  );

  const pushHistory = useCallback((snapshot: WizardDraft) => {
    history.current = [...history.current.slice(-MAX_HISTORY + 1), snapshot];
    setHistoryLen(history.current.length);
  }, []);

  const commit = useCallback(
    (next: WizardDraft, label: string) => {
      pushHistory(draftRef.current);
      draftRef.current = next;
      setDraft(next);
      setUndoLabel(label);
    },
    [pushHistory],
  );

  /** User edit: records history (so voice Undo can revert it) but never flashes. */
  const edit = useCallback(
    (patch: Partial<WizardDraft>, label: string) => {
      commit({ ...draftRef.current, ...patch }, label);
    },
    [commit],
  );

  /** Agent patch: records history, flashes touched fields, arms Undo. */
  const applyAgentPatch = useCallback(
    (patch: Partial<WizardDraft>, touched: Exclude<FlashKey, null>[], label: string) => {
      commit({ ...draftRef.current, ...patch }, label);
      touched.forEach((key) => flash(key));
    },
    [commit, flash],
  );

  const undo = useCallback((): string | null => {
    const prev = history.current.pop();
    if (!prev) return null;
    setHistoryLen(history.current.length);
    draftRef.current = prev;
    setDraft(prev);
    setUndoLabel(null);
    return "Change reverted.";
  }, []);

  const canUndo = undoLabel !== null && historyLen > 0;

  const completed = [
    draft.outcomes.length > 0,
    draft.agentName.trim().length > 0,
    false,
  ];

  return {
    draft,
    draftRef,
    step,
    setStep,
    flashed,
    undoLabel,
    canUndo,
    edit,
    applyAgentPatch,
    undo,
    completed,
  };
}

export type WizardDraftApi = ReturnType<typeof useWizardDraft>;
