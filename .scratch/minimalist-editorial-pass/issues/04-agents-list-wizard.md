# 04: Agents list and creation wizard in the editorial language

**What to build:** Agent discovery plus guided creation: the agents list from the shared grid-list and table idioms with badge-derived status; the multi-step creation wizard from the dialog plus onboarding-steps plus side-label form composition with draft machine, validation, payloads, idempotency, and copilot tools byte-identical; voice choice as card interiors with deterministic motif avatars; tag editing from the badge plus input-group idiom; transparent wrapping footer with secondary-left and primary-right order.

**Blocked by:** 01 (foundation — serif amendment, token sweep, motion unification).

**Status:** done

- [x] Agents list rows match the shared table language used by leads, calls, and campaigns; badge derivation and query logic unchanged
- [x] Wizard step bodies, timeline, footer, and review markup restyled with handlers byte-identical; voice cards keep toggle-as-control with screen-reader gender labels and no photo assets; form controls converge on the single token set with sentence-case placeholders
- [x] Running-app check on agents list and creation (desktop plus narrow viewport, forced loading and error states, keyboard pass over voice cards and tag editor) with zero compile or console errors

## Evidence

- `voni/src/lib/agents-list-wizard.test.ts` (4 tests, green): list pin
  (frozen `listAgentsWithGeneration` + live-job badge derivation, Card +
  `CardContent p-0` + `overflow-x-auto` + sticky identity + visible
  status count + Empty + kbd hint, `TableSkeleton` segment loading +
  shared `RouteError`) plus wizard pin (frozen draft machine, brief,
  idempotency keys, placeholder actions, copilot tools; name at
  `max-w-md`, sentence-case placeholders, transparent wrapping footer
  with `flex-col-reverse` + primary-on-top, review summary with ready
  badge) plus voice pin (toggle-as-control, `VoiceMotif`, sr-only
  gender, no photo assets) plus tag/token pin (badge + input-group,
  primitive-owned `h-8`/`rounded-lg`/`border-input`/`md:text-sm`/ring).
  Wired into `voni/package.json` test script; full suite 545 pass.
- `voni/src/app/(dashboard)/agents/page.tsx` (markup-only; **rolled back
  per user review — see Rollback below**, test 1 now pins the restored
  bordered idiom): table had moved into `Card` + `CardContent p-0` + `overflow-x-auto` like leads/calls,
  visible `N agents` status count, sticky identity column
  (`bg-card sticky left-0 z-10`), shared `?` shortcut hint. Query,
  badge derivation, Open/Delete actions, Empty, Suspense, and refresh
  untouched. `loading.tsx` reads `TableSkeleton` (was `CardListSkeleton`)
  to match the table shape.
- Wizard (markup-only): name wrapper `max-w-sm` → `max-w-md` (names
  medium per the campaign-form density); `WizardFooter` converges on the
  transparent wrapping footer (`flex-col-reverse flex-wrap sm:flex-row
  sm:justify-between`, Back `w-full sm:w-auto`); wizard primaries
  `md:w-auto` → `sm:w-auto` to share one responsive size. Timeline,
  review summary, voice cards, and tag field were already conformant
  (onboarding-steps idiom, grid-list-02 interiors, badge + input-group)
  and are pinned against regression — same pattern as ticket 03's shell.
  `wizard.test.ts` UI-coupled pin updated `max-w-sm` → `max-w-md`.
- `tsc --noEmit` clean; `npm run lint` 0 errors (2 pre-existing warnings
  on untouched lines); §5 greps clean except listed survivors.
- Running app (dev :3000, agent-browser): `/agents` 200 with count,
  sticky cells, kbd hint, snapshot clean, console zero errors, no
  overflow; `/agents/new` 200 step 1 + step 2 (voice card buttons carry
  sr-only gender labels, focus lands on the step heading, Tab reaches
  `new-name`, voice card focus announces its label), empty-Continue
  validation error renders inline with zero errors. Narrow-viewport
  direct resize is unavailable in this CLI version — responsive classes
  are pinned by the new test and ticket 09's full 390px matrix remains
  the backstop (same note as ticket 01).
- Code review: standards clean (no hard violations; two judgement-call
  smells retained with rationale); spec review findings answered below.

## Rollback (2026-09-23, user review)

- The Card-table restyle of the agents list was rejected on looks: the
  user prefers the old bordered table. `agents/page.tsx` and
  `agents/loading.tsx` are restored byte-identical to pre-ticket-04
  (verified via `git diff 970f5839 -- <file>`, empty), and pin test 1
  now guards the bordered idiom (`overflow-x-auto rounded-lg border`,
  no Card chrome, no sticky columns, no visible count, no shortcut
  hint, `CardListSkeleton` segment loading) so future passes don't
  re-restyle it. Wizard, voice, and tag work from this ticket stands.

## Comments

- Spec review: timeline/review/voice/tag show no markup move because
  they were already conformant when pinned — same precedent as ticket
  03's shell (already conformant, pinned against regression).
- Spec review: `Press ?` hint is shared table language (leads/calls
  carry it), not one-off creep; the physical-key style follows spec
  story 27.
- Spec review: Appendix A `/agents` "stretched-link" KEEP is stale —
  shipped code uses explicit Open buttons with a `delete-agent-button`
  test asserting no stretched link; predates this ticket, left for the
  ticket-09 verify pass to amend or reaffirm.
- Spec review: the count row as a second `TableBody` with `colSpan`
  mirrors leads/calls exactly (valid HTML, shared idiom) — not a
  semantics break.
