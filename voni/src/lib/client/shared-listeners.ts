"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * One shared native listener per event family (ticket 07, audit C1).
 *
 * N mounted components subscribe to the same underlying
 * `addEventListener` and fan out from one dispatcher, so mounting the
 * command menu + sidebar + jobs provider + voice call no longer installs N
 * duplicate document/window listeners. Teardown removes the native listener
 * only when the last subscriber leaves, so mount/unmount cycles behave
 * identically with lower cost.
 *
 * Non-blocking by default: lifecycle + custom voice families subscribe with
 * `passive: true` (they never call preventDefault). Keydown + beforeunload
 * keep `passive: false` because they do preventDefault.
 */

type AnyHandler = (event: unknown) => void;

type TargetLike = {
  addEventListener: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
};

type RegistryEntry = {
  handlers: Set<AnyHandler>;
  native: (event: unknown) => void;
  options: AddEventListenerOptions | boolean | undefined;
};

const registries = new WeakMap<object, Map<string, RegistryEntry>>();

function entryFor(target: TargetLike): Map<string, RegistryEntry> {
  let byType = registries.get(target as unknown as object);
  if (!byType) {
    byType = new Map();
    registries.set(target as unknown as object, byType);
  }
  return byType;
}

/**
 * Subscribe to a shared native listener. The first subscriber installs one
 * native listener; every subscriber's handler runs on each event; the last
 * unsubscribe removes the native listener.
 */
export function subscribeShared<E extends Event>(
  target: TargetLike | null | undefined,
  type: string,
  handler: (event: E) => void,
  options?: AddEventListenerOptions | boolean,
): () => void {
  if (!target) return () => undefined;
  const byType = entryFor(target);
  let entry = byType.get(type);
  if (!entry) {
    const handlers = new Set<AnyHandler>();
    const native = (event: unknown) => {
      for (const fn of [...handlers]) fn(event);
    };
    entry = { handlers, native, options };
    byType.set(type, entry);
    target.addEventListener(type, native, options);
  }
  const fn = handler as unknown as AnyHandler;
  entry.handlers.add(fn);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entry.handlers.delete(fn);
    if (entry.handlers.size === 0) {
      try {
        target.removeEventListener(type, entry.native, entry.options);
      } catch {
        // Teardown is best-effort; the handler set is already empty.
      }
      if (byType.get(type) === entry) byType.delete(type);
    }
  };
}

/** Test seam: how many native listeners back this family on this target. */
export function sharedNativeCount(target: TargetLike | null | undefined, type: string): number {
  if (!target) return 0;
  return registries.get(target as unknown as object)?.has(type) ? 1 : 0;
}

/** Test seam: how many subscriber handlers are fanned out. */
export function sharedHandlerCount(target: TargetLike | null | undefined, type: string): number {
  if (!target) return 0;
  return registries.get(target as unknown as object)?.get(type)?.handlers.size ?? 0;
}

function windowTarget(): TargetLike | null {
  if (typeof window === "undefined") return null;
  return window as unknown as TargetLike;
}

function documentTarget(): TargetLike | null {
  if (typeof document === "undefined") return null;
  return document as unknown as TargetLike;
}

// --- Per-family conveniences (fixed targets + non-blocking flags) ---

/** Keydown needs preventDefault (menu toggle, sidebar toggle): non-passive. */
export function subscribeKeyDown(handler: (event: KeyboardEvent) => void): () => void {
  return subscribeShared<KeyboardEvent>(documentTarget(), "keydown", handler, { passive: false });
}

/** Visibility never prevents default: passive. */
export function subscribeVisibilityChange(handler: () => void): () => void {
  return subscribeShared<Event>(documentTarget(), "visibilitychange", handler, { passive: true });
}

/** Freeze (browser stopped the page) never prevents default: passive. */
export function subscribeFreeze(handler: () => void): () => void {
  return subscribeShared<Event>(documentTarget(), "freeze", handler, { passive: true });
}

/** Window focus never prevents default: passive. */
export function subscribeFocus(handler: () => void): () => void {
  return subscribeShared<Event>(windowTarget(), "focus", handler, { passive: true });
}

/** Pagehide saves memory, never ends the call: passive. */
export function subscribePageHide(handler: () => void): () => void {
  return subscribeShared<Event>(windowTarget(), "pagehide", handler, { passive: true });
}

/** Online reconnect never prevents default: passive. */
export function subscribeOnline(handler: () => void): () => void {
  return subscribeShared<Event>(windowTarget(), "online", handler, { passive: true });
}

/** Voice mutual-exclusion fan-out (voice-call + copilot share one native). Passive. */
export function subscribeVoicePreempt(handler: (event: Event) => void): () => void {
  return subscribeShared<Event>(windowTarget(), "voni:voice-preempt", handler, { passive: true });
}

/** Voice prefs refresh fan-out. Passive. */
export function subscribeVoicePrefsChanged(handler: () => void): () => void {
  return subscribeShared<Event>(windowTarget(), "voni:voice-prefs-changed", handler, { passive: true });
}

/** Beforeunload warns on dirty edits: needs preventDefault, so non-passive. */
export function subscribeBeforeUnload(handler: (event: BeforeUnloadEvent) => void): () => void {
  return subscribeShared<BeforeUnloadEvent>(windowTarget(), "beforeunload", handler, { passive: false });
}

/** React hook over the shared registry (client provider boundary). */
export function useSharedEvent<E extends Event>(
  kind: "window" | "document",
  type: string,
  handler: (event: E) => void,
  options?: AddEventListenerOptions | boolean,
): void {
  useEffect(() => {
    const target = kind === "window" ? windowTarget() : documentTarget();
    return subscribeShared<E>(target, type, handler, options);
    // Handler identity is the caller's contract (useCallback where stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, type]);
}

// --- Shared matchMedia (one cached query + one change listener per query) ---

const mqlCache = new Map<string, MediaQueryList>();

/** Cached MediaQueryList per query string; null on the server. */
export function getSharedMatchMedia(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia === "undefined") return null;
  let mql = mqlCache.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    mqlCache.set(query, mql);
  }
  return mql;
}

/** Subscribe to one query's change fan-out (passive: change never prevents default). */
export function subscribeMatchMedia(query: string, onChange: () => void): () => void {
  const mql = getSharedMatchMedia(query);
  if (!mql) return () => undefined;
  return subscribeShared<Event>(mql as unknown as TargetLike, "change", onChange, { passive: true });
}

/** Shared media-query hook: identical booleans, one native change listener per query. */
export function useSharedMatchMedia(query: string, serverFallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => subscribeMatchMedia(query, onChange),
    () => getSharedMatchMedia(query)?.matches ?? serverFallback,
    () => serverFallback,
  );
}
