Status: ready-for-agent

## Problem Statement

The landing demo call is persona role-play (real estate, car dealership, restaurant). It captures nothing about the visitor, and nothing about it signals that it is meant for real businesses. Visitors leave anonymous, and credits go to people who are just playing around.

## Solution

Voni talks as itself and turns the visitor into a **Prospect** through live "real-world tests." The visitor emails Voni. Voni finds the email in a busy shared inbox and replies with a code, and the visitor reads the code back. Meanwhile Voni reads their website and brainstorms with them about their business. Each ask is a step in a test that benefits the visitor. The moment the visitor feels the capture, we've failed. A work-email gate, a talk clock (2 → 4 → 7 min), and a stakes ladder make the call feel serious and protect credits. The whole call stays in one session: no callback.

## Beats are mini-goals with stakes

Each beat has a goal. A visitor who stalls or plays around gets a nudge first, then a clear, warm warning with the stakes ("we've only got a couple of minutes and I take this seriously; if we can't move forward I'll have to end the call"). A third off-track stretch means a polite end: "…if you'd like to try again properly, the team's at hi@voni.cc." Jev scores off-track per turn.

## Conversation beats

1. **Open**: Voni speaks as itself. The persona tabs are removed; the voice and language picker stays. "Hi, I'm Voni! Let's try something cool: I'll show you what I can do while we talk. Ready?" A yes goes straight into the email test; the business talk comes after it (owner, 2026-09-27: short attention span, engage first).
2. **Invite the test**: "Let's try something real: send me an email from your work address and watch how fast I handle it." The address appears as a tap-to-copy chip (with a `mailto:` link on phones), and Voni says it once. No consent line here.
3. **Hold** (automatic, on phones and desktop): when the page is hidden (the visitor opens Mail or switches tab), the call goes on Hold. Voni says "Go ahead, I'll hold," and the mic and talk clock pause. *(Amended 2026-09-27: the hold is silent, and there is no welcome-back line on return. Instead, after 15s of silence on a free floor, Voni checks in once: "Still with me? Take your time." Every line the call prompts goes through one floor gate, so it never lands on a reply, a tool call, or the caller.)* During the hold, Jev matches the newest plausible sender in the shared inbox, and Voni pre-reads that domain's website. If the connection drops during the hold, the call reconnects on return with the conversation context carried over.
4. **Claim** (after "sent"; the tag finds the email, so no address is asked for unless they used another subject): "I'm getting lots of emails, from you and others testing me. To keep everyone's data safe, which address did you use?"
   - **Business domain** → provisional extension. If the pre-read matched: "Andres! I've already been through acme-realty.com while you were away…" Otherwise: "Give me a second, I'm looking at your site now…" The name comes from the address, or Voni asks for it lightly later.
   - **Free-email domain** → work-email gate: "Got it! But that's a personal address, and I need your work one. Can you send it from there?" If they don't have one, Voni says "No problem!" and carries on without the reply or code (no verified time), never a hang-up (owner, 2026-09-27).
   - **Won't send any email** → the stakes ladder, then the same polite end.
5. **Business talk (the wait, used)**: Voni says it's analyzing their site and understanding their business. It asks what they do, whether they've tried this kind of tech, and where it could help, and it brainstorms ideas for their business.
6. **Reply + code check**: when Jev matches the email (claim ↔ sender, plus a spoof/spam check), Voni narrates truthfully as it works: "writing it… sending… just sent." The reply contains their name, a 4-digit code framed as "a code to test things out, tell me what it says," and a short warm line. The visitor gets two tries.
7. **Reveal**: the code passes → verified extension. "That was actually an OTP, a security check. Didn't feel like one, right?" Then Voni opens up the whole trick: the entire call was a fun way to capture their details (name, verified email, what their business does) without a single form, and there are plenty more creative ways to do this for their customers. "How efficient did that feel to you?"
8. **Consent + close** (while they're enjoying it): "Glad you liked it. Mind if the team follows up at andres@acme-realty.com?" A "no" marks the Prospect no-marketing. Then: "I've passed my notes on. Anything you'd like them to prepare?" The answer goes on the Prospect.

## Clock

- Talk clock: 2 min base → about 4 min on a claimed business address → 7 min after a passed code check.
- The talk clock pauses on mute and on hold. After about 20s of mute, Voni checks in once, gently. Hold is capped at about 2 min.
- A hard wall-clock cap of about 12 min, including mute and hold, protects credits.
- If the email never arrives, Voni keeps talking business until the provisional limit, then says "I'll reply the moment it lands" and closes politely. The reply still goes out after the call.

## Agent rules

- Never announce data collection before the reveal. Every ask is a step in a test.
- Narration tracks the real tool state. Never say "sent" or "read your site" early.
- Speak and write the reply in the picked language. The team summary is English.
- v1 never asks for a phone number or WhatsApp.

## Jev roles

Uses the existing `typesafe-ai/jev` via `/api/voice-judge` and `voni/src/lib/voice/jev-judges.ts`:

1. Match an inbound email to the caller (claimed address, speech-to-text near-misses, timing).
2. Flag spoof/spam.
3. Score off-track per turn for the stakes ladder.

Free vs. business email is decided by a plain domain list, not by Jev.

## Prospect record (team-only)

Name, claimed email, verified flag, domain, website summary, what they do, prior tech use, ideas brainstormed, the intent answer, consent/no-marketing, language, off-track warnings, transcript, and the AI summary. Shown on an admin page gated by `VONI_ADMIN_EMAILS`.

## Capabilities needed (implementation not yet chosen)

Facts:
- The demo agent has no tools. `voni/src/lib/demo/stored-agents.ts` sends none, and the `ToolCoordinator` is inline-only in `voni/src/lib/voice/session.ts`.
- The 120s cap is in the token (`voni/src/app/api/demo/token/route.ts`).
- There is no email send or read; the Gmail tools in `voni/src/lib/providers/registry.ts` are stubs.
- `leads` needs an org and a phone.
- The `ringback` earcon exists in `voni/src/lib/voice/call-sounds.ts`.
- Mute is `setInputMuted`, and the timer derives from `startedAt` (`voni/src/components/voice-call.tsx`).

Needed:
- Demo-agent tools: match inbox, send reply with code, verify code, read website, extend, end call.
- Mint the session with a ~12-min cap and enforce the talk clock on our side.
- A `visibilitychange` hold, plus reconnect with carried context.
- Jev judge prompts for the three roles.
- A free-email domain list.
- The `prospects` table, admin page, and summary.
- A copy chip in the call card, amending the transcript-only rule in `voni/DESIGN.md` §10c.

## Amendment 2026-09-27: Test tag (supersedes beat 4's claim question and the Clock numbers)

- The invite gives the visitor a **Test tag** to put in the subject (e.g. "Lime 42"). The chip shows the address and the tag, and Voni says only the tag. Voni finds the email by the tag, and the sender's address is the claim.
- The spoken "which address did you use?" is used only when the visitor raises it ("I forgot the tag").
- **Talk clock:** 4 min base → 6 min when a business-domain email arrives (the provisional extension) → 9 min after the code check. The hard cap stays ~12 min.
- **Tag lifetime and callbacks:**
  - A tag lives 24h, in the browser and the server registry.
  - A callback from the same browser keeps the tag. If the email landed meanwhile, Voni mentions it, skips the invite, and the extension applies at once.
  - A sender who matched an earlier tag is greeted as returning.
- No email by the end of the talk time → "I'll reply the moment it lands", then a polite close.
- See `docs/adr/0004-test-tag-email-matching.md`.

## Dropped / deferred

- Browser callback: dropped, because it risks losing prospects. Keep them in the call.
- Web Push: dropped along with the callback.
- Phone/WhatsApp tests: v2 ("WhatsApp me," visitor-initiated).
- `test@voni.cc` via Cloudflare Email Routing: after the domain is registered. Until then the test inbox is nedalk.js@gmail.com. Shared-inbox noise is wanted.
