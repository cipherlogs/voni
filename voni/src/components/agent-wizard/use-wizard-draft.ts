"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationLanguage } from "@/lib/agents/wizard";
import {
  CONVERSATION_LANGUAGES,
  DEFAULT_CONVERSATION_LANGUAGE,
  DEFAULT_WIZARD_VOICE_ID,
} from "@/lib/agents/wizard";

export const WIZARD_STEPS = ["Goals & Tasks", "Personality"] as const;

/** The single source of truth both the user's mouse and the guide edit. */
export type WizardDraft = {
  goals: string[];
  tasks: string[];
  agentName: string;
  styleTraits: string[];
  conversationLanguage: ConversationLanguage;
  /** AssemblyAI voice catalog id. `anna` is the one validated on real calls. */
  voiceId: string;
};

export const EMPTY_DRAFT: WizardDraft = {
  goals: [],
  tasks: [],
  agentName: "",
  styleTraits: [],
  conversationLanguage: DEFAULT_CONVERSATION_LANGUAGE,
  voiceId: DEFAULT_WIZARD_VOICE_ID,
};

/** Field keys the guide can flash when it applies a patch. */
export type FlashKey =
  | "goals"
  | "tasks"
  | "agentName"
  | "styleTraits"
  | "voice"
  | "conversationLanguage"
  | null;

const MAX_HISTORY = 20;

/**
 * Durable pre-submit draft (PR4): the wizard survives reload/navigation via
 * localStorage. Submitted jobs are covered by the placeholder row + ?job=
 * restore instead — this cache is cleared on save and on Start over.
 */
const DRAFT_CACHE_KEY = "voni:wizard-draft";

type CachedDraft = { draft: WizardDraft; step: number };

function isCachedDraft(value: unknown): value is CachedDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const d = v.draft as Record<string, unknown> | null;
  if (typeof d !== "object" || d === null) return false;
  const strArray = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((i) => typeof i === "string");
  return (
    strArray(d.goals) &&
    strArray(d.tasks) &&
    strArray(d.styleTraits) &&
    typeof d.agentName === "string" &&
    typeof d.voiceId === "string" &&
    typeof d.conversationLanguage === "string" &&
    (CONVERSATION_LANGUAGES as readonly string[]).includes(
      d.conversationLanguage,
    ) &&
    (typeof v.step === "number" || typeof v.step === "undefined")
  );
}

function readCachedDraft(): CachedDraft | null {
  if (typeof window === "undefined") return null;
  try {
    return parseWizardDraftCache(window.localStorage.getItem(DRAFT_CACHE_KEY));
  } catch {
    return null;
  }
}

/**
 * Pure cache parser (exported for unit tests): corrupt, partial, or
 * foreign-shape payloads are rejected so the wizard falls back to empty.
 */
export function parseWizardDraftCache(raw: string | null): CachedDraft | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCachedDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Drop the durable draft: call after a successful save or Start over. */
export function clearWizardDraftCache() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DRAFT_CACHE_KEY);
  } catch {
    // Private-mode writes fail silently; the wizard still works in-memory.
  }
}

/**
 * Totally-terminal reset for a finished creation (Goal 8): drop the durable
 * pre-submit draft AND the in-tab consumed-job entries minted by this
 * creation, so a brand-new creation starts at step 1 with no failed brief or
 * stale review pointer. The in-memory undo stack (max 20) is hook state and
 * dies with the unmount — nothing to clear here. Per-agent
 * `voni:edit-draft:<id>` keys are untouched: wizard resets must never clobber
 * another screen's unsaved edits.
 */
export function resetWizardForNewCreation() {
  clearWizardDraftCache();
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(CONSUMED_JOBS_KEY);
  } catch {
    // Private-mode writes fail silently; the restore guard just won't fire.
  }
}

/** In-memory step reset for a fresh creation: step 0 with the draft cache
 * already dropped (see resetWizardForNewCreation for the durable half).
 * Exported as a named target so callers and tests can pin the contract. */
export const WIZARD_FRESH_STEP = 0;

/**
 * Consumed generation jobs (back-nav twin guard): job ids whose reviewed save
 * already upgraded the placeholder in place. sessionStorage survives
 * back-navigation and reloads in-tab but never leaks across tabs — the stale
 * ?job= pointer in history must not re-seed a review that has already been
 * saved. Append-only; a saved job never becomes unconsumed.
 */
const CONSUMED_JOBS_KEY = "voni:wizard-consumed-jobs";

function readConsumedJobs(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(CONSUMED_JOBS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/** True when this job id's review was already saved in this tab. */
export function isJobConsumed(jobId: string): boolean {
  if (!jobId) return false;
  return readConsumedJobs().includes(jobId);
}

/** Record a saved job id so a browser Back to ?job= cannot re-seed it. */
export function markJobConsumed(jobId: string) {
  if (typeof window === "undefined" || !jobId) return;
  try {
    const next = readConsumedJobs();
    if (!next.includes(jobId)) {
      next.push(jobId);
      window.sessionStorage.setItem(CONSUMED_JOBS_KEY, JSON.stringify(next));
    }
  } catch {
    // Private-mode writes fail silently; the restore guard just won't fire.
  }
}

/**
 * Shared wizard state: one draft, step position, per-field flash, and a
 * snapshot history so every agent patch — and every user edit — is undoable
 * internally (the visible Review undo button is gone; voice undo remains).
 */
export function useWizardDraft() {
  const [draft, setDraft] = useState<WizardDraft>(
    () => readCachedDraft()?.draft ?? EMPTY_DRAFT,
  );
  /** Ref mirror so delayed callbacks (voice patches) resolve against the
   * latest draft instead of a send-time snapshot. */
  const draftRef = useRef<WizardDraft>(draft);
  const [step, setStepState] = useState(() => {
    // Post-terminal caches are dropped by resetWizardForNewCreation, so any
    // cache present here is a live pre-submit draft — restore its step. No
    // cache (fresh or post-terminal creation) starts at WIZARD_FRESH_STEP.
    const cached = readCachedDraft()?.step ?? WIZARD_FRESH_STEP;
    return Math.min(Math.max(cached, 0), WIZARD_STEPS.length - 1);
  });
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

  // Persist every committed state so reload/navigation restores the wizard.
  // Best-effort: quota or private-mode failures never break the wizard.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        DRAFT_CACHE_KEY,
        JSON.stringify({ draft, step }),
      );
    } catch {
      // Ignore write failures; in-memory state stays authoritative.
    }
  }, [draft, step]);

  const setStep = useCallback((next: number) => {
    setStepState(next);
  }, []);

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
    draft.goals.length > 0,
    draft.agentName.trim().length > 0,
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
