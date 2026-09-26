# 02: Hold when the visitor leaves the page

**Goal:** I can leave the call to open my Mail app or another tab, come back, and the call is still there with Voni remembering where we were, on my phone and on desktop.

**What to build:** When the demo page becomes hidden (the visitor switches app or tab), the call goes on **Hold**. Voni says "Go ahead, I'll hold," the mic pauses, and the talk clock stops. Hold lasts at most ~2 minutes; after that the call ends politely. When the visitor returns, the call resumes. If the phone dropped the audio or connection while away, returning reconnects seamlessly with the conversation context carried over, so Voni doesn't start from scratch. Voni greets the return ("Welcome back!"). The hard real-time cap still applies.

**Blocked by:** 01 (Voni as itself: tools, talk clock, stakes ladder).

**Status:** ready-for-human (implementation done, manual real-device test steps 1–4 pending)

## Manual test (approve / reject)

Run on a real iPhone (Safari) and a real Android phone (Chrome) with `npm run dev:phone` over https, plus desktop Chrome.

1. Start a call and tell Voni your favorite color. Switch to the Mail app (phone) or another tab (desktop). → Before or as you leave, Voni says it'll hold.
2. Stay away 30s, come back. → Voni says "welcome back," the call continues, and Voni still knows your favorite color. The clock didn't advance while you were away.
3. On the iPhone, stay away ~60s (long enough for Safari to cut audio), then return. → The call reconnects on its own within a couple of seconds and still remembers the color. No need to press Call again.
4. Leave for more than 2 minutes. → On return, the call has ended politely (with a clear message on screen), not hung silently.
5. Do not leave the page at all. → Nothing about hold happens.

## Acceptance criteria

- [ ] Page hidden → Hold: mic paused, talk clock paused, spoken "I'll hold."
- [ ] Hold cap ~2 min, then a polite end with a clear on-screen state.
- [ ] Return resumes. A dropped connection reconnects with the conversation context carried over.
- [ ] Works on iOS Safari, Android Chrome, and desktop. Verified on real devices.
- [ ] Tests for the hold state transitions (hidden, visible, cap, reconnect).

## Answer

- Hold state: `voni/src/lib/demo/hold.ts` (`HoldState`, `HOLD_CAP_S = 120`, `buildHoldCarryover`). Pure timestamps; the component owns listeners, mic, and lines.
- Talk clock: `TalkClock.setHeld` pauses on the union of mute/hold (overlap counts once); hold never arms the mute check-in. Wall cap (`WALL_CLOSE_S`) still never pauses, clock preserved across restarts.
- Mic: `VoiceSession.setOnHold` drops frames with hidden `HOLD_ON/OFF_CONTEXT` (never a reply or transcript row). `pagehide` still ends true unloads; `visibilitychange` hidden is the only hold signal (blur was cut: false holds from devtools/dialogs).
- Return paths: live session → un-hold + "Welcome back!" via `ReplyQueue`; in-flight auto-resume → greet on arrival; dead session (post-30s-grace) → fresh transport preserving turns/clock/ladder/mute + hidden carryover context so Voni resumes instead of restarting. Over-cap → polite end + "The call ended while you were away."
- Automated: full suite green 645/645 (`npm test`), incl. new `hold.test.ts` (in suite), talk-clock union, session hold/mute-overlap, and `voice-call.test.ts` hold wiring. `tsc` + `eslint` clean.
- Code review: standards clean; spec deltas accepted — inbox/site pre-read stays in 03/05, cap is per-stretch, goodbye may speak while hidden (on-screen copy is the acceptance), dead-session cap end is on-screen-only.

### Manual-test risks to watch (real devices)

- Mic re-acquire without a fresh gesture (iOS AudioContext may stay suspended until a tap; first tap should unstick it).
- Desktop app-switch without minimize may not fire `visibilitychange` (ticket desktop case is another tab, which does).

### Follow-up round 3 (stale error + double greeting on return)

- Root causes, all in the hold-return path: (1) `start()` never stopped the old session, so its late socket failure painted "call ended unexpectedly" over the fresh connecting screen; (2) a fresh transport binds the stored agent whose greeting always plays, then the carryover + HOLD_RETURN spoke a second greeting; (3) the welcome-back had two unguarded enqueue sites.
- Fixes: stop-then-start in `start()` (stale callbacks die with `explicitStop`); a `returnPending`/`returning` window from hold exit until audio lands — Reconnecting… note shows, no error banner paints, terminal transport failures rejoin silently; `welcomeBackOnce` per return on all three arrival paths.
- Single greeting needs a server lever: per AssemblyAI docs, `agent_id` is mutually exclusive with inline fields, so the browser cannot suppress the stored greeting. Token route takes strict `resume === true` and binds a `:resume` stored-agent sibling (same prompt/tools, no greeting → waits silently); the carried context + welcome-back reply is the single first utterance. No migration: the variant rides the existing unique index as a `voice:resume` storage key.
- Deliberately NOT changed: the rejoin predicate still reads the consumed greet flag, not the pending flag — rejoining on every terminal failure of an already-fresh start would loop forever on a dead network. A mute check-in due inside the reconnect window is dropped rather than stomping the welcome-back (queue is latest-wins).
- Watch-items (no evidence yet, not built): hung resume with zero events; cumulative multi-stretch cap.
- Verified: `npm test` 652/652, `tsc` + `eslint` clean, dev-server compile + landing render check clean. Real-device re-test (phone Gmail round + desktop tab round) still pending — that is the acceptance that matters.

### Follow-up round 2 (phone "ended unexpectedly" + hold-line rotation)

- Phone root cause: returning onto an in-flight auto-resume that then fails (1008/exhausted) left the call dead — the greet-on-arrival flag had no failure branch. `onError` now rejoins silently (preserved transport + carryover) on terminal `network`/`expired` only, via pure `shouldRejoinAfterHold` (`voni/src/lib/demo/hold.ts`); mic/auth/config failures still surface.
- Hold line rotates (`HOLD_ENTER_LINES`, canonical first) and every hold turn is fenced to its single line, so repeats don't sound canned and a hold turn can't smuggle an answer to an earlier question. Desktop extra-reply was not reproducible; trace step dropped.
- Watch-items (no evidence yet, not built): a resume that hangs with zero events (no error, no ready) has no forced rejoin; cumulative multi-stretch hold has no cap.
