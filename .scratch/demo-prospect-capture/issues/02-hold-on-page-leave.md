# 02: Hold when the visitor leaves the page

**Goal:** I can leave the call to open my Mail app or another tab, come back, and the call is still there with Voni remembering where we were, on my phone and on desktop.

**What to build:** When the demo page becomes hidden (the visitor switches app or tab), the call goes on **Hold**. Voni says "Go ahead, I'll hold," the mic pauses, and the talk clock stops. Hold lasts at most ~2 minutes; after that the call ends politely. When the visitor returns, the call resumes. If the phone dropped the audio or connection while away, returning reconnects seamlessly with the conversation context carried over, so Voni doesn't start from scratch. Voni greets the return ("Welcome back!"). The hard real-time cap still applies.

**Blocked by:** 01 (Voni as itself: tools, talk clock, stakes ladder).

**Status:** ready-for-agent

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
