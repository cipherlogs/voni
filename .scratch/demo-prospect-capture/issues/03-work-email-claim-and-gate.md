# 03: Work-email claim and gate

**Goal:** When I email Voni from a work address during the call, Voni finds my email in the busy inbox, greets me by name, and gives me more time. If I use gmail, it politely turns me away.

**What to build:** The invite beat: "send me an email from your work address and watch how fast I handle it." The call card shows the test inbox address as a tap-to-copy chip, with a `mailto:` link on phones. This amends the transcript-only rule for the call card in the design system, so record that amendment. Voni says the address once.

After the visitor says they've sent it (or returns from Hold), Voni asks the claim question: "I'm getting lots of emails, from you and others testing me. To keep everyone's data safe, which address did you use?" Then:

- **Business domain:** the provisional extension (talk clock to ~4 min). Voni greets them by the name visible in the address, or asks for it lightly later.
- **Free-email domain** (a plain domain list, no model): the work-email gate. Voni asks "Do you have a work email? We only work with verified businesses." If they have none: "No problem. Reach the team at hi@voni.cc and we'll gladly look into it," then a polite end.
- **Refusing to send any email:** the stakes ladder from 01.

The server reads the test inbox (hi@pilotxstudio.com for now; was nedalk.js@gmail.com until 2026-09-26). A Jev judge picks which recent email belongs to this caller: it compares the spoken address, allowing for speech-to-text near-misses, with each sender and the arrival time. It also flags spoof or spam. If the email hasn't arrived by the provisional limit, Voni says "I'll reply the moment it lands" and closes politely.

**Blocked by:** 01 (Voni as itself: tools, talk clock, stakes ladder).

**Status:** ready-for-human (follow-up round 1 done; the owner's real call + phone checklist pending)

## Manual test (approve / reject)

Make sure the test inbox has some unrelated emails in it, to simulate other testers.

1. Start a call, agree to the test. → Voni invites you to send an email. The address chip appears; tapping it copies the address (on a phone, the mail link opens Mail).
2. Send an email from a work address (e.g. you@yourcompany.com). Tell Voni "sent." → Voni asks which address you used.
3. Say the address. → Within a few seconds Voni confirms it found your email and greets you by the name in the address. The clock now allows ~4 minutes.
4. Say the address slightly wrong (e.g. one letter off, as speech-to-text might hear it). → Voni still matches your email, or asks you to confirm.
5. New call: send from a gmail address and claim it. → Voni asks for a work email. Say you don't have one. → Voni mentions hi@voni.cc warmly and ends the call.
6. New call: claim a work address but never send the email. → Voni keeps talking until ~4 min, says it'll reply once the email lands, and ends politely.
7. New call: refuse to send anything. → The nudge, warning, end ladder from 01.

## Acceptance criteria

- [ ] Address chip with copy, plus `mailto:` on phones. Design-system amendment recorded.
- [ ] Server reads the test inbox. The Jev matcher finds the caller's email among others, tolerating near-miss spellings, with a fallback that works without Jev.
- [ ] Spoof/spam flag from Jev. A flagged email is not treated as a match.
- [ ] Free-email domain list → gate with hi@voni.cc → polite end.
- [ ] Business claim → provisional extension (~4 min talk clock).
- [ ] Late-email path: "I'll reply the moment it lands," then a polite close.
- [ ] Tests for the gate classification, the extension transitions, and the matcher fallback.

## Answer

- **Owner decisions (2026-09-26):** Gmail REST + OAuth refresh token (`gmail.modify`, so 04 can reply without re-consent); the browser re-checks every 8s after a business claim and a hidden note announces the arrival; the chip appears via a `show_test_address` tool call on the invite; spoof = Gmail's DMARC/SPF verdict as a hard rule, plus Jev.
- **Pure core:** `voni/src/lib/demo/email-test.ts` handles claim normalization (spoken "at/dot/dash"), the free-domain list, the name taken from the address, the header spoof rule, the fallback matcher (≤2 edits), `checkEmail` (Jev injected), and the call state (invited → claimed → found) with `talkLimitS` (240s on a business claim).
- **Server:** `voni/src/lib/demo/inbox.ts` does the Gmail read and Jev match/spoof, and `runCheckEmail` is dispatched by `/api/demo/tools/[name]`. `jevEvaluate` and `judgeDepsFromSecrets` were extracted in `voice-judge.ts` and are shared with `/api/voice-judge`.
- **Matching rules (after review):**
  - Only email that arrived during this call counts. The call token carries the start time, and a rejoin or reload keeps the same token.
  - An exact sender wins without asking Jev. Jev weighs near misses only, bounded to ≤6 edits.
  - On a near miss, Voni never reads the other sender's address aloud. It asks the visitor to spell theirs, and the call stays in "claimed" until an exact match.
  - The sender's address and message ids never leave the server.
- **Client:** `voice-call.tsx` holds the email-test state. It covers the chip (`demo-address-chip.tsx`, DESIGN.md §10c amendment), the talk limit, the beat goal for the off-track judge (`EMAIL_BEAT_GOAL`, so refusing the test climbs the ladder), the claim question on a hold return after the invite, the late-email close (`LATE_EMAIL_INSTRUCTIONS`), and the inbox poll.
- **Setup:** see `voni/ENVIRONMENT.md` "Demo test inbox" and `scripts/mint-demo-inbox-token.mts`. Without the token, every claim reads as "not landed yet". Refresh tokens expire after 7 days while the consent screen is in Testing.
- **Verified:** `npm test` 706/706, `tsc` and `eslint` clean (one pre-existing warning in copilot-provider). e2e `tests/e2e/demo-email-test.spec.ts` (chip + copy + phone mailto, poll → note → stop, free never polled, 2-min base vs 4-min extension + late-email close) plus the hold spec with token-carry checks: 24/24 on desktop and Pixel 7, and mutation checks fail as expected. A real route call with a minted call token returned the free gate and not_arrived.
- **Known ceilings:** one Gmail page (30 messages) per check, marked `ponytail:` in inbox.ts. The Voni lines are English prompts only (the model speaks the picked language).

### Follow-up round 1 (2026-09-27): owner's first real call, Test tag redesign

Plan: `~/.claude/plans/mutable-frolicking-dongarra.md`; decision record: `docs/adr/0004-test-tag-email-matching.md`.

- **Found in the call (`sess_c477d8f8`):**
  - An invented inbox address: the show tool timed out at 5s during a 10s invite reply.
  - `check_email("unknown")` before the visitor answered.
  - The inbox was never read (the dev server predated the token).
  - The goodbye was cut after "No problem.".
  - The transcript stopped following.
  - Scrolling silenced Voni (mic noise barge-in with no resume).
- **Decisions:**
  - The talk clock is 4 / 6 / 9 min.
  - The **Test tag** (word + 2 digits, per language) replaces the claim question. The spoken address is used only when the visitor raises it.
  - The extension comes only when a business email arrives.
  - The tag lives 24h and carries over to the next call from the same browser. A sender who matched before is greeted as returning.
  - A late call closes with "I'll reply the moment it lands".
  - Website research (05) comes after 04.

**Built (round 1):**
- **Test tag** (`voni/src/lib/demo/test-tag.ts`, registry `test-tag-registry.ts`, table `demo_test_tags`, migration 0012 applied to the dev DB directly):
  - A word + 2 digits, per language, unique among live tags.
  - It lives 24h, carried in the browser as a signed token (`localStorage voni:test-tag`) and named in the call token.
- **Matching by tag** (`checkTag` in `email-test.ts`, `listTaggedMessages` in `inbox.ts`):
  - The tag is found in the subject or body however it was typed.
  - The DMARC/SPF rule and Jev spoof check still apply.
  - The work-email gate runs on the sender's domain.
  - A match is recorded on the tag, and a same-sender earlier tag marks the visitor as returning.
  - The spoken address remains only as the visitor-raised fallback.
- **Clock:** 4 min base → 6 min only when a business email arrives. Invited but nothing landed → "I'll reply the moment it lands".
- **Invite:**
  - Voni puts the chip up (address + tag, `mailto:?subject=` on phones) with a short lead-in.
  - The call then *replaces* the platform's own reply to the tool result with its invite carrying the exact tag (`VoiceSession.replaceNextReply`, resent once if the platform ignores it).
  - A hidden context message gives Voni the tag at session start.
- **Call-quality fixes:**
  - Tool results go back at once. Holding interactive results for `reply.done` deadlocked until the tool timed out: the root cause of the invented address.
  - `end_call`'s result waits for the goodbye reply to finish; sent earlier, the platform cut the goodbye's audio. That was the "No problem." cut.
  - A cut with no words resumes after 1.5s (wheel clicks, noise).
  - The transcript re-follows after a wheel tick at the bottom.
  - See `docs/adr/0005-tool-results-send-at-once-except-end-call.md`.
- **Owner setup still needed:**
  - Enable the Gmail API in Google Cloud project 942470299274 (every inbox read got 403 "Gmail API has not been used in project").
  - Restart `npm run dev:phone` (`.dev.vars` is read at startup).
  - Run `scripts/verify-demo-inbox.mts`.

**Finish-up (2026-09-27):**
- **Owner's real inbox test:** the tag was put in the body (subject "ops"). The matcher now takes the subject or the start of the body, needs exactly one distinct tag, and ignores case and spacing. Re-checked against the real inbox: the work email was found ("Nedal"), the gmail one was gated.
- **Review fixes:**
  - A tag in both subject and body counts once.
  - No digit-joining across phone numbers.
  - The screen fallback is tighter and never re-invites once the email is found.
  - Words after a cut cancel the noise resume.
  - A noise-cut goodbye re-arms the hang-up.
  - A held `end_call` result is always sent, and the stall release is 3s.
  - Tags are not reissued within 48h.
- **Tests:** unit 737/737; browser e2e 44/44 (desktop + Pixel 7, repeated runs), every new fix mutation-checked.
- **Live evals** (the AssemblyAI credit ran out mid-pass; the owner capped the rest at ~$8):
  - 10/10 before the cap: invite-tag, sent-no-placeholder, refusal, filler-over, over-talk.
  - 5/5 on the targeted rerun: hang-up-fast, hang-up-over, greeting-cut, late-close, free-gate, forgot-tag, bye-audio, returning.
  - stop-over 5/5 run alone. Its earlier misses were parallel-load latency, the same at the prior commit (ADR 0003).
  - 3/3 after the final session fixes: hang-up-fast and hang-up-over (~0.96s hang-ups).
  - hang-up 4/5: the model spoke the tool call as text, the known ~1-in-19 case from ticket 01.
- **Known, pre-existing:** a caller talking over the goodbye occasionally gives a 12–19s hang-up (hang-up-over; the same at the prior commit).
- **Still to do:** the owner's real desktop call + `npm run call:trace`, then the phone checklist.
