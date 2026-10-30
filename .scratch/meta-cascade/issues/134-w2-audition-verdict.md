# 134: Record the cascade audition verdict

**What to build:** The owner listens to the cascade call and records a verdict with date and reasons, separate from the two ballots. Accept means the content did not hold up; withdraw means it did.

**Blocked by:** 133 (The cascade re-audition pack)

**Status:** ready-for-human

- [ ] The owner records accept, withdraw or unresolved with date and reasons, separate from the ballots.
- [ ] Accept means content did not hold up; withdraw means it did. The decision record's meanings are not flipped.
- [ ] An unnamed manual check is not a verdict unless the human and the capture are both named.
- [ ] An unresolved pack blocks the locale and is not a pass.

## Comments

### 2026-10-30 — agent implementation note (recorder only; no verdict, no call)

Added the recorder that ticket 133 deliberately left out. The pack still never
decides; nothing here fabricates a verdict.

- `voni/src/lib/demo/cascade-verdict.ts`: `recordCascadeOwnerVerdict(pack, input, packPath)` + `formatCascadeVerdictSection` + `applyCascadeVerdictToAdr`. `justifiesRenderingLayer` and `blocksLocale` are **derived** from one `MEANINGS` table (`accept` → `true`/`false`, `withdraw` → `false`/`false`, `unresolved` → `null`/`true`), so a caller cannot flip ADR 0008's meanings. It refuses, by name: an unnamed reviewer, an unnamed capture (also for `unresolved` when the pack is complete), a capture whose sha256 is not the pack's delivered recording, a pack whose recorded hash disagrees with its own file, a missing/blank reason, a non-ISO or future date, and `accept`/`withdraw` on an incomplete pack (the pack's blockers are quoted; ballot sufficiency is the pack's, not re-derived here).
- `voni/src/lib/demo/adr-section.ts`: one `replaceAdrSection` walk shared by both re-audition recorders, anchored to a line-start heading so a prose mention cannot leave a stale body.
- `voni/scripts/cascade-verdict.mts` (`npm run voice:cascade-verdict`): hashes the named `--capture` before recording, writes `verdict.json` beside the pack, and with `--adr` appends the `## W2 cascade re-audition (owner verdict)` section **beside** the managed `## Re-audition (W2 gate)` section without touching the document status. A run without `--adr` says so by name, so a verdict cannot silently live only in the gitignored run directory. A `withdraw` states that it contradicts the managed accept and that withdrawing ADR 0008 is a separate owner decision. The pack is re-checked at this boundary: a hand-edited `status: "complete"` that disagrees with its own ballots or blockers is refused by name.
- Evidence: `cascade-verdict.test.ts` + `adr-section.test.ts` (18 tests: named owner verdict, unflipped meanings, unnamed human/capture, missing reason/date, future date, invalid decision, capture not on disk, incomplete-pack refusal, missing ballot, unresolved-on-complete-pack capture rule, missing/misdescribed pack capture, ADR coexistence + idempotency + later-section replace + prose-mention anchor). Full `npm test` → 2362 tests, 2361 pass, 1 skipped, 0 fail; `npm run typecheck` clean; `npm run lint` 0 errors (2 pre-existing warnings in `scripts/reviewer-pack.mts`).
- Left for the owner: **no live cascade artifact exists yet** (all 30 runs in `voni/scoreboard-runs/` are managed). Make one live browser cascade call for `lola`/`es`, build its pack (`scoreboard:demo --pipeline cascade --ledger …`), listen to the delivered capture, then run `npm run voice:cascade-verdict`. The ticket stays `ready-for-human`; no verdict was recorded.

