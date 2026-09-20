# 07: Voice section contract + manifest migration

**What to build:** Spoken section names land on the new routes; app manifest regenerated, per-route briefs accurate, recognition vocabulary and consistency tests green.

**Blocked by:** 03.

**Status:** done — ready for ticket 08

- [x] Old tab-open contract resolves to route navigation for every section name
- [x] Manifest regeneration passes its check test; guide consistency tests green
- [x] Per-route briefs describe the current section accurately

## What shipped

- **Manifest** (`scripts/generate-app-manifest.mts` + regen v2→v3): `/settings/[tab]` template expands into five concrete static destinations (`/settings/account|voice|workspace|services|appearance`), each with own phrases/title/3 examples; `/settings` phrases slimmed to landing terms; `account` added to `APP_FEATURE_TERMS` (18 terms, within budget). `NAVIGABLE_ROUTES` 11→16, destinations 19→23, record 5→4, signed-in 15→19. `SETTINGS_TABS_MANIFEST` kept as the `ui_settings_tab` allow-list.
- **Intent + guide** (`app-guide.ts`): no matcher change needed (static routes pick up automatically); guide line reworded to sections-with-routes + `ui_settings_tab` for named section routes.
- **Tool contract** (`ui-tools.ts`, name + `tab` param kept per lock): description → section route, `Unknown settings tab.` → `Unknown settings section.`; system-prompt law 7 + transcription scene reworded tab→section; `/settings*` routes share the settings recognition scene via exact prefix match.
- **Briefs**: verified accurate against section components (no drift — account session/sign-out, voice prefs + confirmed-save, workspace gate, services counts + operator boundary, appearance options); pinned by a new source-contract test.
- **Tests**: `app-guide.test.ts` (counts, no-template, section-name→route incl. no-repush, feature-terms section nouns), `ui-tools.test.ts` (10/10 value+label→route, unknown refused), `copilot-lib.test.ts` (section routes share scene + keyterms), `settings-routes.test.ts` (brief accuracy incl. workspace gate ternary).

## Review dispositions (two-axis review, fixes applied)

- Fixed: `route.startsWith("/settings")` over-match → exact `=== "/settings" || startsWith("/settings/")`; `account` missing from `APP_FEATURE_TERMS`; workspace brief pin tightened from generic substrings to the gate ternary; stale ticket-02 "until then" line in `settings-tiles.ts` comment.
- Dismissed with rationale: briefs live in `[tab]/page.tsx` from ticket 02 (this ticket verifies + pins accuracy, no reimplementation); `settingsTab` accepts value|label only (free-speech aliases belong to `matchNavIntent`, both pinned); action-style examples (`Sign out`, `Switch to dark mode`) don't train navigation (matcher uses phrases only — house pattern from prior manifests); `settingsTab`/`tab` naming kept deliberately (ticket-02 precedent + locked decision).
