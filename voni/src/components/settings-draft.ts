"use client";

import { useEffect } from "react";

export type SettingsDraftSection = "voice" | "workspace";

export interface VoiceDraft {
  voiceId: string;
  language: string;
}

export interface WorkspaceDraft {
  name: string;
  timezone: string;
  humanTransferNumber: string;
}

/**
 * Draft storage keys (ticket 03): per-section localStorage keys so an
 * unfinished edit in one section never overwrites another's. Values are
 * display drafts only — credentials never touch localStorage (the providers
 * section saves immediately and carries no draft).
 */
export function settingsDraftKey(section: SettingsDraftSection): string {
  return `voni:settings:${section}-draft`;
}

/** Voice form is dirty when either field differs from the saved prefs. */
export function isVoiceDirty(current: VoiceDraft, saved: VoiceDraft): boolean {
  return current.voiceId !== saved.voiceId || current.language !== saved.language;
}

/** Workspace form is dirty when any field differs from the saved settings. */
export function isWorkspaceDirty(current: WorkspaceDraft, saved: WorkspaceDraft): boolean {
  return (
    current.name !== saved.name ||
    current.timezone !== saved.timezone ||
    current.humanTransferNumber !== saved.humanTransferNumber
  );
}

/**
 * Warn on reload/close while dirty (ticket 03, edit-agent precedent).
 * SPA navigation across the route split is covered by draft retention in
 * the owning form — this guard covers the browser-level leave path that
 * retention cannot.
 */
export function useBeforeUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // preventDefault alone suffices in modern browsers; returnValue keeps
      // the prompt working where it is still required.
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}

/**
 * Read a retained draft. Best-effort: private-mode/quota failures and
 * corrupt JSON read as no draft — the server props stay authoritative.
 */
export function readSettingsDraft<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Retain a dirty draft so navigating to another section and back restores
 * the unfinished edit; clearing (null) drops the key so a saved form never
 * resurrects stale inputs. Best-effort writes — failures never break typing.
 */
export function writeSettingsDraft<T>(key: string, value: T | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore write failures; in-memory state stays authoritative.
  }
}
