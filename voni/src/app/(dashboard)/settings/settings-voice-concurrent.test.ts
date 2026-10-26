import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, path), "utf8");

// Seam under test: the server data boundary of the settings `[tab]` page
// (the VoiceData leaf). Catches: serial session + voice-prefs reads.
// Misses: real DB latency (static shape assertion — the full gate plus the
// dev-server runtime check cover behavior).
function voiceDataBody(page: string): string {
  const match = page.match(/async function VoiceData\(\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "VoiceData leaf exists");
  return match[1];
}

test("voice-preference and session-context reads resolve concurrently", () => {
  const body = voiceDataBody(source("[tab]/page.tsx"));
  // One parallel group over the session guard + the voice-prefs read — the
  // sibling WorkspaceData/ServicesData Promise.all pattern. Baseline was 2
  // sequential roundtrips on the voice tab vs 1 parallel group on siblings.
  assert.match(body, /Promise\.all/);
  assert.match(body, /requireCtxOrRedirect/);
  assert.match(body, /getCopilotVoicePrefs/);
  // No serial chain: the guard must not be awaited alone before prefs start.
  assert.doesNotMatch(
    body,
    /await requireCtxOrRedirect[^;]*;\s*\n\s*const voicePrefs = await/,
  );
});

test("voice tab shows the same values, Tiles, and badges with no visual change", () => {
  const page = source("[tab]/page.tsx");
  // Same data: the leaf still renders the voice brief and prefs section.
  assert.match(page, /RouteBrief route="\/settings\/voice"/);
  assert.match(page, /VoiceSection prefs=\{voicePrefs\}/);
  // Same Tile composition: heading and content share one lookup.
  assert.match(page, /settingsSectionTile/);
  // Deliberate instant opt-out stays — out of scope for this ticket.
  assert.match(page, /export const instant = false/);
});
