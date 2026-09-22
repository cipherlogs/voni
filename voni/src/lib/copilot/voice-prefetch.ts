/**
 * Voice-initiated background prefetch for speculative navigation.
 *
 * Separate from `HoverPrefetchLink` (which owns hover-intent Link prefetch
 * and deliberately avoids `router.prefetch` — see settings-prefetch.test.ts).
 * This module only wraps the Next `router.prefetch` passed in by the
 * copilot provider so mid-sentence partials can warm RSC payloads before
 * the confirmed turn navigates — the destination then flashes instead of
 * showing a `loading.tsx` skeleton.
 */
import { NAVIGABLE_ROUTES } from "./app-manifest";

/** Static routes to warm when a voice session starts (filtered by role). */
export function getSessionPrefetchRoutes(platformAdmin = false): string[] {
  if (platformAdmin) return [...NAVIGABLE_ROUTES];
  return NAVIGABLE_ROUTES.filter((route) => route !== "/operator");
}

/** Drop candidates already warmed — prefetch is idempotent but noisy. */
export function dedupePrefetch(candidates: string[], already: Set<string>): string[] {
  return candidates.filter((route) => !already.has(route));
}

export type PrefetchFn = (route: string) => void | Promise<unknown>;

/**
 * Best-effort warm of each candidate. Never throws — prefetch must not fail
 * the voice path. Marks warmed routes into `seen` so repeats stay silent.
 */
export async function prefetchCandidates(
  prefetch: PrefetchFn,
  candidates: string[],
  seen: Set<string>,
): Promise<void> {
  for (const route of dedupePrefetch(candidates, seen)) {
    try {
      await prefetch(route);
    } catch {
      /* Best-effort: a failed warm just means the later nav loads normally. */
    }
    seen.add(route);
  }
}
