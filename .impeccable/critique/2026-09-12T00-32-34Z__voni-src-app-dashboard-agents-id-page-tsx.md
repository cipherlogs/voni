---
target: agent detail page + test-this-agent
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/home/cipherlogs/Repos/AI/leadcalls/voni/src/app/(dashboard)/agents/[id]/page.tsx"
target_fingerprint: "sha256:f0478236ed3a927a0ec77459f89f75934c3e0553d510c62742b567dc538cae21"
target_path: /home/cipherlogs/Repos/AI/leadcalls/voni/src/app/(dashboard)/agents/[id]/page.tsx
timestamp: 2026-09-12T00-32-34Z
slug: voni-src-app-dashboard-agents-id-page-tsx
---
Method: dual-agent (Assessment A: design review · Assessment B: detector + browser evidence, run in isolation)

## Design Health Score — 23/40 (Acceptable)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | On-screen vs saved vs deployed versions never labeled |
| 2 | Match System / Real World | 3 | Phone model faithful; stock portrait breaks "your employee" |
| 3 | User Control and Freedom | 2 | No cancel for in-flight save/deploy; voice switch wipes session |
| 4 | Consistency and Standards | 3 | House patterns kept; voice ToggleGroup vs language Buttons diverge |
| 5 | Error Prevention | 2 | Testing unsaved edits by silent default invites lost work |
| 6 | Recognition Rather Than Recall | 2 | Three config versions + wizard-side result held in head; no diff |
| 7 | Flexibility and Efficiency | 1 | Zero accelerators; every tweak→test→save costs full-page scroll |
| 8 | Aesthetic and Minimalist Design | 2 | Call card restrained; page gives five equal-weight cards + banners |
| 9 | Error Recovery | 3 | Best area; save failures are toast-only with no persistent anchor |
| 10 | Help and Documentation | 2 | Strong per-field hints; no mic priming, script, or cap disclosure |
| **Total** | | **23/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment:** 60% authored, 40% interchangeable admin. The voice-ops brain lives in the microcopy ("Spoken as a sequence," "understands only," "waits for result," "previous deployed version keeps taking calls") — written by someone who understands telephony. But the shell (five identically-chromed Cards: Identity / Mission / Conversation / Tools and channels / Test this agent) could be any SaaS settings page. The declared primary action (TEST CALL) carries exactly the same visual weight as "Company (Optional)." Missed character: inline mode shows a stock persona portrait — a stranger, not "your employee"; no operator framing (on shift, today's calls, what callers heard); the agents → calls → campaigns → customers loop is invisible.

**Deterministic scan:** `impeccable detect --json` on `edit-agent.tsx` + `voice-call.tsx` returned `[]` (exit 0, zero findings). No additional issues caught; no false positives to flag — consistent with the design review scoring Consistency 3 and the repo's `shadcn-audit.md` having already converted known violations. Mechanical scan is clean; every priority issue below is structural/IA (layout order, hierarchy, version mental model, banner stacking), which a linter cannot see.

**Visual overlays:** none — no script injection performed. Authenticated `/agents/[id]` render skipped (Google sign-in gate, no session); public landing verified HTTP 200 as fallback signal.

## Overall Impression

The engineering is genuinely good (fixed card geometry, distinguished error states, previous-version-stays-live deploys) but invisible in the layout. The page's best sentences are buried in cards that all look the same, the primary action has no primacy, and users carry an unlabeled three-version mental model. Biggest opportunity: make the tweak → test → save loop feel like one loop instead of three stacked chores.

## What's Working

1. **Fixed-height call card with one internal flexing region.** Layout shift is a trust issue on a "talk while reading" page; this kills it. Frozen controls dim in place rather than hiding — real craft.
2. **Failure copy that names the safe state.** "Phone calls will keep using the previous deployed version," the 429 countdown, distinct mic/drop/hang-up endings. Panic converted into patience.
3. **"Spoken as a sequence."** A sub-second telephony parameter translated into operator language with the why attached, placed exactly at the decision. The authored-for-Voni bar the rest of the page should meet.

## Priority Issues

**[P0] The primary action has no primacy; Save is below the fold.**
Why: declared loop is tweak → test → save; layout taxes every iteration with full-page scroll while Test dresses identically to "Company (Optional)."
Fix: two-column desktop (config left, sticky test rail right) + sticky save bar with dirty state.
Suggested command: `layout`

**[P1] Three config versions, zero labels.**
Why: users can test edits and leave believing they're live, or save believing the test covered the deployed version. Wrong-mental-model bug.
Fix: version strip on Test card ("Testing unsaved edits • Save to deploy" vs "Testing saved version") + dirty dot on save bar and Badge.
Suggested command: `clarify`

**[P1] Generation + deployment-attention banners stack with no hierarchy; ready state invites editing a stale draft.**
Why: first-timer can diligently edit the placeholder while the real config waits on the wizard review screen; two Alerts + Badge can report three truths.
Fix: one ordered status stack (Generating → Review in wizard → Deploying → Live); overlay-disable the form when generation is ready.
Suggested command: `distill`

**[P2] Voice switch silently discards the session.**
Why: `key={voiceId}` remounts the card; transcript evidence vanishes with no warning. (Mid-call switching is correctly frozen; the wipe hits idle/ended state, when the transcript is most valuable.)
Fix: disclose "switching voice starts a fresh session" + preserve last transcript, or confirm when turns exist.
Suggested command: `harden`

**[P2] Fixed-height card starves the transcript on mobile.**
Why: at 360px, `h-[22rem]` fits ~2 bubbles; cycler/toggle targets are 24px. No-shift tradeoff is right; density budget inside is wrong.
Fix: taller inline card on small screens with expandable transcript; 44px targets.
Suggested command: `adapt`

## Persona Red Flags

**Alex (power operator):** every tweak→test cycle costs full scroll each way; no sticky test/save; no keyboard path; transcript destroyed by voice change; no diff since save/deploy; mid-deploy progress only via global Jobs pill; 18-language wall on every visit.

**Jordan (first-timer):** doesn't know the test targets unsaved edits; mic prompt arrives unprimed; no suggested first line; learns the 180s cap at 30s left; 429 reads as personal fault; generation-ready shows three doors with no guidance; Delete beside Save reads as danger on day one.

**Sam (keyboard/screen-reader):** foundations good (`aria-live` badge, labeled buttons, labeled transcript viewport). Breaks: listening/speaking/timer line is not a live region; transcript turns not announced (captions missed entirely); error box not `role="alert"`; post-load banners don't move focus; 18-language tab walk with no skip link; Save/Delete adjacent in tab order.

**Casey (mobile thumb):** ~2-bubble transcript; Test above four long cards with Save unreachable and nothing sticky; 18 wrapping pills push Save further; sub-44px targets; `text-xs`/`text-[11px]` copy strains; hang-up button (48px, centered) is the pattern to copy.

## Minor Observations

- Inline mode never discloses the 3-minute cap pre-call (demo discloses "2 min max").
- Severity mismatch: failed deployment = destructive Alert; failed generation = default Alert.
- Save failure = toast-only; deployment failure = full Alert. Inconsistent failure altitude.
- Delete `layout="full"` beside full-width Save on mobile: maximum fat-finger adjacency.
- "Call again anytime" overpromises under rate limits.
- Generation spinner: no %, step, or ETA despite the job system knowing state.
- Three "View in Jobs" links diffuse the one place slow work lives.

## Questions to Consider

- If TEST CALL is primary, why does the page *end* at Save/Delete — what would "promote this test to live" replacing "Save changes" mean?
- What would the page look like if the agent were an employee on shift (presence, today's calls, what callers heard) rather than a config file with a phone widget?
- The best engineering here is invisible in the layout — what would make a first-timer *feel* that reliability in five seconds?

## Run Notes

Target slug: `voni-src-app-dashboard-agents-id-page-tsx`. Ignore list: none (no ignore.md; one prior snapshot exists). Assessments independent (A completed before B output entered synthesis). CLI detector: exit 0, `[]`. Browser: dev server already running (port 3000, reused, not started); landing verified; authenticated states skipped (Google gate). Overlay injection: not attempted. Live server: none started. agent-browser tab closed after use.
