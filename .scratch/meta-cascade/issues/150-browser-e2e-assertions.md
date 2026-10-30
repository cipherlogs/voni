# 150: What the browser seam proves

**What to build:** The browser seam asserts the behaviours only a real client can prove: negotiated format, cushion and drift, barge-in flush and cut, the greeting chime, duplicate sequence drop, the goodbye drain and a visible error.

**Blocked by:** 149 (A real browser seam writes a delivered capture on every PR)

**Status:** resolved

- [ ] The negotiated format is played at the rate the session confirmed.
- [ ] Cushion and drift do not modulate the voice.
- [ ] Barge-in flushes and cuts within the cut budget.
- [ ] The greeting fires the chime on the first audible sample.
- [ ] A duplicate sequence number is dropped, the goodbye drains and an error is visible.
- [ ] The delivered capture is sample-exact and non-intrusive.

## Answer

# 150 — What the browser seam proves

**Status: done.** Branch `cluster/e2e-150`, commit `a8d94e79`, based on integration
tip `43f0d427` (`git merge feat/meta-cascade` → "Already up to date").
Ticket AC authority; the prompt's "greeting before user audio / reply ordering"
reads as the managed script and is not in this ticket — the cascade trace proves
barge-in cut, reply ordering after the flush, dead air and the chime instead.

- **Built:** the 149 seam now asserts what the caller experienced, all from the
  real capture + fake timestamps + DOM, no client hooks. Fixture regenerated as
  a 16 kHz (deliberately ≠ the 24 kHz default) two-tone trace: 440 Hz reply
  (seq 1–6) → `interrupted` at 500 ms → 730 Hz reply (seq 7–9) → seq 7/8
  replayed → `end_call`. `CascadeSession` now mirrors `CallPlayout` (ticket 98's
  documented browser contract): a frame whose `seq` is not greater is dropped
  and named in the log; an unnumbered frame still plays. Assertions: stamped
  rate by captured pitch + reply length; level spread < 1.5 (cushion/drift do not
  modulate); cut `firstReply < elapsed + realCutMs` from `SCOREBOARD_BUDGETS`;
  second reply = 1.2 s ± 0.2 (a played duplicate makes it 2.0 s); chime once and
  only after the first audio frame (negative case: caption+error call has no
  audio → no chime); stop ≥ 0.8 × goodbye after `end_call`; dead air ≤
  `deadAirMaxMs`; peak sample step < 4000 (no tap-block seam); error alert text.
- **Red proofs (each feature deleted, suite red, then reverted):** seq gate off →
  second reply **2.000 s vs 1.400 s** bound (`150-red-seq.log`); `flush()` off →
  **2380 ms vs 1842 ms** cut bound; rate stamp ignored → no scripted tone
  audible; chime moved to connect → fires with no audio (test 2). One red log is
  kept; the other three were observed in this session at the cited numbers.
- **Green:** `node scripts/e2e-run.mjs cascade` → exit 0, 2 passed in 8.5 s
  (candidate build 190.1 s), artifact `browser-delivery.json`:
  firstReply 0.52 s / cut 508 ms, secondReply 1.18 s, chime +110 ms, drain
  1285 ms, peak step 1560. `npm test` 2199 pass / 1 skip / 0 fail;
  `npm run typecheck` clean; eslint clean on the touched files.
- **Merger notes:** (1) `voice-pipeline/transport.py:on_audio` still omits `seq`,
  so the dedupe guard is inert against the real service until the transport
  stamps frames (ticket 98 owns `CallSequence`; `SentenceAudio` has no seq yet) —
  the browser accepts unnumbered frames, so nothing breaks meanwhile. (2) The
  `ci.browser_e2e_budget_s` bound remains OPEN (149), so the runner still prints
  UNMEASURED. (3) `playwright-report/` is untracked noise; untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
