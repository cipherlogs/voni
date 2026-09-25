# 01: Voni as itself: tools, talk clock, stakes ladder

**Goal:** I can call Voni on the landing page, and it talks as itself, stops the clock when I mute, and ends the call politely if I mess around.

**What to build:** The landing demo call drops the persona scenario tabs (real estate, car dealership, restaurant). Voni answers as itself with the opening beat from the spec. The voice and language picker stays, and the conversation happens in the picked language. This ticket also lays the groundwork the later tickets use:

- The demo agent can call tools during a demo call, through a public route that is scoped to the call so it can't be used outside that session. The first tool is "end call".
- The call runs on the **talk clock**: a 2-minute base that pauses while the visitor is muted, under a hard ~12-minute real-time cap for credits. After ~20s muted, Voni checks in once, gently.
- Voni follows the **stakes ladder**: a nudge, then a warm warning that names the stakes, then a polite end pointing to hi@voni.cc. A new Jev judge scores each visitor turn as on-track or off-track against the current beat's goal.

Rate limits stay as they are.

**Blocked by:** None (can start immediately).

**Status:** done, awaiting manual test (steps 2–6 need a live voice call)

## Manual test (approve / reject)

1. Open the landing page. → No persona tabs. The voice/language picker is still there.
2. Start a call. → Voni opens with "Hi, I'm Voni… I'd rather show you than tell you. Sound good?" (in the picked language).
3. Talk for ~30s, mute for 40s, unmute. → The visible clock froze while muted. Voni checked in once, around the 20s mark of the mute, and didn't nag again.
4. Keep talking normally until 2 minutes of talk time. → The call ends politely at about 2:00 of talk time, not 2:00 of real time.
5. New call: answer with nonsense or jokes 3 times in a row. → First a light nudge, then a clear warning about the stakes, then a polite goodbye that mentions hi@voni.cc, and the call ends.
6. Switch the picker to another language and repeat step 2. → Voni opens in that language.

## Acceptance criteria

- [ ] Persona tabs removed; Voni's own prompt and greeting are used for every voice and language.
- [ ] The demo agent can call tools through a route scoped to the call; "end call" works.
- [ ] The talk clock pauses on mute. Base 2 min. A hard real-time cap of ~12 min is enforced on the server as well as the client.
- [ ] One gentle check-in after ~20s muted.
- [ ] The stakes ladder (nudge, warning, polite end + hi@voni.cc) is driven by a Jev off-track judge, with a fallback that works when Jev is unavailable.
- [ ] Existing test suite green, plus tests for the talk clock and the ladder logic.

## Answer

- Voni agent: `voni/src/lib/demo/voni-agent.ts`. The ‹ › switcher cycles one voice per language; personas are deleted.
- Call-scoped tools: `/api/demo/token` mints an HMAC `callToken` (`lib/demo/call-token.ts`). The session relays tool calls to `/api/demo/tools/[name]` using it as the bearer. `end_call` is the first tool (`lib/demo/demo-tools.ts`). Later tools need a case there and on the stored body.
- Talk clock: `lib/demo/talk-clock.ts`, 120s base, paused on mute, one check-in 20s into each mute. The server cap is 720s via the token; the client starts its close at 700s. Later tickets extend it here.
- Stakes ladder: `lib/demo/stakes-ladder.ts`. Strikes are cumulative. `ReplyQueue` delivers each rung by `reply.create` once the current reply or caller turn is done. The judge is `off-track` on `/api/voice-judge` (demo callToken auth, off-track only), with a lexical heuristic fallback. The beat goal is `OPEN_BEAT_GOAL` until later beats land.
