/**
 * Hand-written layer over the GENERATED app manifest: the global prompt
 * section and the optimistic-navigation intent matcher.
 *
 * Data comes from app-manifest.ts (regenerate, never hand-edit that file);
 * the matching and wording rules live here, unit-tested in app-guide.test.ts.
 */
import {
  APP_DESTINATIONS,
  SETTINGS_TABS_MANIFEST,
} from "./app-manifest";

/** Global prompt section: every destination, so voice never misses a screen. */
export function renderAppGuide(platformAdmin = false): string {
  const places = APP_DESTINATIONS.filter((d) => d.access === "signed-in" || (platformAdmin && d.access === "platform-admin")).map((d) => `${d.title} (${d.route}, ${d.navigationKind})`).join(", ");
  const tabs = SETTINGS_TABS_MANIFEST.map((t) =>
    t.adminOnly ? `${t.label} (admin)` : t.label,
  ).join(", ");
  return [
    `APP GUIDE — every place you can take the user; navigate immediately when asked: ${places}.`,
    `Settings sections (each its own /settings/<section> route): ${tabs}. Use ui_settings_tab to open a named section route. Voice and language preferences use ui_select with confirmed proposals, then confirm Save separately. Changes apply to the next conversation. Credential values never enter the browser; operators rotate them with the server CLI.`,
    "ui_navigate accepts only generated static routes. Dynamic templates describe record types, never literal destinations. Use ui_search_records for agents, campaigns, leads and calls, then ui_open_record with one returned opaque reference; ask the user to select ambiguous matches. Search jobs are creator-scoped and survive navigation. Open a finished search in Jobs, or read its result for matches.",
    "ui_read_screen returns readable content and up to 60 controls with scope, query, total and continuation. Repeat scope/query with the continuation for overflow. ui_tap, ui_fill, ui_select and ui_scroll use the returned snapshot refs. Disabled controls cannot run. Upload commands reveal the control for manual file selection; reread validation, propose the durable import and await confirmation.",
    "Stale or replaced targets require a fresh read and, for edits, a fresh proposal and assent. A reread never reapplies a mutation. accepted means dispatched or durably queued; completed means the tool observed the result. Say pending when completion is unverified, and use screen or job status to check.",
  ].join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wake-word strip: removes a leading "hi/hey/hello + michael…" so
 * "Hi, Michael open the settings page" matches like "open the settings".
 * Only strips a leading invocation — "tell michael…" mid-sentence is kept.
 */
const WAKE_RE = /^\s*(hi|hey|hello|ok|yo)?[,\s]*\b(michael|michelle|michaela|mike)\b[,\s]*/i;

export function stripWakePhrase(spoken: string): string {
  return spoken.replace(WAKE_RE, "").trim();
}

/**
 * Optimistic navigation: match what the user is saying against destinations
 * BEFORE the model turn completes, so the page moves while they speak.
 * Returns the route, or null when nothing (new) matches.
 *
 * Rules: word-boundary match (so "leaders" never routes to /leads), longest
 * phrase wins ("new agent" beats "agent"), never re-push the current route.
 * Recognition, not authorization — the model's confirmed turn stays the
 * authority and may navigate anywhere allowed afterward.
 */
export function matchNavIntent(spoken: string, currentRoute: string, platformAdmin = false): string | null {
  const hits: Array<{ route: string; length: number }> = [];
  for (const destination of APP_DESTINATIONS) {
    if (destination.navigationKind !== "static" || destination.route === currentRoute) continue;
    if (destination.access === "platform-admin" && !platformAdmin) continue;
    let best = 0;
    for (const phrase of destination.phrases) {
      const pattern = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i");
      if (pattern.test(spoken) && phrase.length > best) best = phrase.length;
    }
    if (best > 0) hits.push({ route: destination.route, length: best });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.length - a.length);
  return hits[0].route;
}

export type NavPrefixCandidate = { route: string; confidence: number };

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Prefix-tolerant ranking for mid-sentence partials ("settin…" → /settings).
 * Full-phrase hits belong to matchNavIntent — this only fires on prefixes so
 * cumulative deltas can prefetch/navigate before the final transcript.
 *
 * Guards: min 4-char overlap, word-start prefixes only (so "leaders" never
 * matches "leads"), short phrase words (<=4 chars) need exact match, never
 * the current route. Returns up to 3 candidates sorted by confidence.
 */
export function rankNavPrefix(
  spoken: string,
  currentRoute: string,
  platformAdmin = false,
): NavPrefixCandidate[] {
  const cleaned = stripWakePhrase(spoken);
  const spokenWords = tokenizeWords(cleaned).filter((w) => w.length >= 3);
  if (spokenWords.length === 0) return [];
  // Full-phrase hits are authoritative — prefix ranking stays silent then.
  if (matchNavIntent(cleaned, currentRoute, platformAdmin)) return [];

  const scored: Array<{ route: string; confidence: number; matched: number; phraseLen: number }> = [];
  for (const destination of APP_DESTINATIONS) {
    if (destination.navigationKind !== "static" || destination.route === currentRoute) continue;
    if (destination.access === "platform-admin" && !platformAdmin) continue;
    let best = 0;
    let bestPhraseLen = 0;
    const matchedWords = new Set<string>();
    for (const phrase of destination.phrases) {
      for (const phraseWord of tokenizeWords(phrase)) {
        if (phraseWord.length <= 4) {
          if (spokenWords.includes(phraseWord)) {
            matchedWords.add(phraseWord);
            if (0.9 > best) {
              best = 0.9;
              bestPhraseLen = phrase.length;
            }
          }
          continue;
        }
        for (const said of spokenWords) {
          if (said.length < 4) continue;
          const prefix =
            phraseWord.startsWith(said) || said.startsWith(phraseWord);
          if (!prefix) continue;
          matchedWords.add(phraseWord);
          const overlap = Math.min(said.length, phraseWord.length);
          const confidence =
            overlap >= 6 ? 0.85 : overlap === 5 ? 0.75 : 0.6;
          if (confidence > best) {
            best = confidence;
            bestPhraseLen = phrase.length;
          }
        }
      }
    }
    if (best > 0) {
      const boosted = matchedWords.size >= 2 ? Math.min(0.95, best + 0.05) : best;
      scored.push({ route: destination.route, confidence: boosted, matched: matchedWords.size, phraseLen: bestPhraseLen });
    }
  }
  scored.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.matched - a.matched ||
      a.route.length - b.route.length ||
      a.phraseLen - b.phraseLen,
  );
  return scored.slice(0, 3).map(({ route, confidence }) => ({ route, confidence }));
}

export type PartialNavAction =
  | { action: "navigate"; route: string; confidence: number }
  | { action: "prefetch"; candidates: string[] }
  | { action: "none" };

/**
 * Single decision point for onUserPartial: full match navigates now,
 * strong prefix (>=0.8) navigates to the top candidate, weaker prefix
 * prefetches the top-2 so the final turn paints instantly with no loading
 * flash.
 */
export function classifyPartialNav(
  spoken: string,
  currentRoute: string,
  platformAdmin = false,
): PartialNavAction {
  const cleaned = stripWakePhrase(spoken);
  if (cleaned.length < 4) return { action: "none" };
  const full = matchNavIntent(cleaned, currentRoute, platformAdmin);
  if (full) return { action: "navigate", route: full, confidence: 0.95 };
  const ranked = rankNavPrefix(cleaned, currentRoute, platformAdmin);
  if (ranked.length === 0) return { action: "none" };
  if (ranked[0].confidence >= 0.8)
    return { action: "navigate", route: ranked[0].route, confidence: ranked[0].confidence };
  if (ranked[0].confidence >= 0.6)
    return { action: "prefetch", candidates: ranked.slice(0, 2).map((r) => r.route) };
  return { action: "none" };
}
