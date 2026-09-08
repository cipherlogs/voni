"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const WIZARD_STEPS = ["Goal", "Personality", "Tasks", "Review"] as const;

/** The single source of truth both the user's mouse and the guide edit. */
export type WizardDraft = {
  goal: string;
  agentName: string;
  personality: string;
  tasks: string[];
  /** AssemblyAI voice catalog id. `anna` is the one validated on real calls. */
  voiceId: string;
  /**
   * `input.language_codes` steering. Empty means automatic detection across
   * all supported languages — more capable than a pinned list, not less.
   */
  languageCodes: string[];
};

export const EMPTY_DRAFT: WizardDraft = {
  goal: "",
  agentName: "",
  personality: "",
  tasks: [],
  voiceId: "anna",
  languageCodes: [],
};

/** Field keys the guide can flash when it applies a patch. */
export type FlashKey =
  | "goal"
  | "agentName"
  | "personality"
  | "tasks"
  | "voice"
  | "languages"
  | null;

const MAX_HISTORY = 20;

/**
 * Shared wizard state for the A-variant demos (and the seed of the real
 * phase-2 sync store): one draft, step position, per-field flash, and a
 * snapshot history so every agent patch — and every user edit — is undoable.
 * Fake only: no network, no persistence.
 */
export function useWizardDraft() {
  const [draft, setDraft] = useState<WizardDraft>(EMPTY_DRAFT);
  /** Ref mirror so delayed callbacks (voice patches) resolve against the
   * latest draft instead of a send-time snapshot. */
  const draftRef = useRef<WizardDraft>(EMPTY_DRAFT);  const [step, setStep] = useState(0);
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

  /** User edit: records history (so Undo can revert it) but never flashes. */
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

  const toggleTask = useCallback(
    (task: string) => {
      const prev = draftRef.current;
      const on = prev.tasks.includes(task);
      commit(
        {
          ...prev,
          tasks: on ? prev.tasks.filter((t) => t !== task) : [...prev.tasks, task],
        },
        "task change",
      );
    },
    [commit],
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

  const completed = useMemo(() => {
    return [
      draft.goal.trim().length > 0,
      draft.agentName.trim().length > 0 || draft.personality.trim().length > 0,
      draft.tasks.length > 0,
      false,
    ];
  }, [draft]);

  const progress = Math.round(((step + 1) / WIZARD_STEPS.length) * 100);

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
    toggleTask,
    undo,
    later,
    completed,
    progress,
  };
}

export type WizardDraftApi = ReturnType<typeof useWizardDraft>;
