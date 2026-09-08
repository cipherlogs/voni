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
export function renderAppGuide(): string {
  const places = APP_DESTINATIONS.filter((d) => d.access === "signed-in").map((d) => `${d.title} (${d.route}, ${d.navigationKind})`).join(", ");
  const tabs = SETTINGS_TABS_MANIFEST.map((t) =>
    t.adminOnly ? `${t.label} (admin)` : t.label,
  ).join(", ");
  return [
    `APP GUIDE — every place you can take the user; navigate immediately when asked: ${places}.`,
    `Settings tabs (all on /settings): ${tabs}. Use ui_settings_tab to open a visible tab. Voice and language preferences use ui_select with confirmed proposals, then confirm Save separately. Changes apply to the next conversation. Credential values are private and must be entered manually.`,
    "ui_navigate accepts only generated static routes. Dynamic templates describe record types, never literal destinations. Use ui_search_records for agents, campaigns, leads and calls, then ui_open_record with one returned opaque reference; ask the user to select ambiguous matches. Search jobs are creator-scoped and survive navigation. Open a finished search in Jobs, or read its result for matches.",
    "ui_read_screen returns readable content and up to 60 controls with scope, query, total and continuation. Repeat scope/query with the continuation for overflow. ui_tap, ui_fill, ui_select and ui_scroll use the returned snapshot refs. Disabled controls cannot run. Upload commands reveal the control for manual file selection; reread validation, propose the durable import and await confirmation.",
    "Stale or replaced targets require a fresh read and, for edits, a fresh proposal and assent. A reread never reapplies a mutation. accepted means dispatched or durably queued; completed means the tool observed the result. Say pending when completion is unverified, and use screen or job status to check.",
  ].join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
export function matchNavIntent(spoken: string, currentRoute: string): string | null {
  const hits: Array<{ route: string; length: number }> = [];
  for (const destination of APP_DESTINATIONS) {
    if (destination.navigationKind !== "static" || destination.route === currentRoute) continue;
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
