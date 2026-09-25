Status: needs-triage

## Problem Statement

The landing demo call is persona role-play (real estate, car dealership, restaurant). It captures nothing about the visitor, and nothing about it signals that it is meant for real businesses. Visitors leave anonymous, and the call's credits are spent on people who are just playing around.

## Solution

Voni talks as itself and turns the visitor into a **Prospect** through live "real-world tests." The visitor emails Voni, Voni finds the email and replies with a code, and the visitor reads the code back. Meanwhile Voni researches their business from their email domain and brainstorms with them. Each ask is a step in a test that benefits the visitor. The moment the visitor feels the capture, we've failed. A work-email gate and a staged clock (2 → 4 → 7 min) add scarcity and protect credits.

## Conversation beats

1. **Open**: Voni speaks as itself. The persona tabs are removed; the voice and language picker stays. "Hi, I'm Voni. I know you're here to see how useful this would be for your business. I'd rather show you than tell you. Sound good?"
2. **Invite the test**: "Let's try something real: send me an email and watch how fast I handle it." The card shows the inbox address as a tap-to-copy chip (with a `mailto:` link on phones), and Voni says it once. In the same breath: "…and the Voni team may follow up there too, OK?" A "no" marks the Prospect no-marketing.
3. **Claim**: after the visitor says they sent it: "I'm getting lots of emails, from you and others testing me. To keep everyone's data safe, which address did you use?"
   - **Free-email domain** → work-email gate: "Sorry, this demo is for businesses only. Got a work email?" Voni re-prompts once. If they still refuse: "I'll let you go, come back when you want to try it for real," then a polite hang-up.
   - **Business domain** → provisional extension (to about 4 min). If the address shows a name ("andres@"): "Andres, nice to meet you." Otherwise Voni asks for the name lightly, later.
   - **Won't send any email** → same as the gate: one re-prompt, then a polite hang-up.
4. **Research and business talk**: "I'm looking at acme.com right now…" Voni asks what they do, whether they've tried this kind of tech, and where it could help, and it brainstorms concrete ideas for their business. This also fills the wait if the email is slow.
5. **Reply + code check**: when the email lands and matches the claim, Voni narrates truthfully as it works: "writing it… sending… just sent." The reply contains their name, a 4-digit code framed as "a code to test things out, tell me what it says," and a short warm line Voni writes itself. The visitor gets two tries.
6. **Reveal**: when the code checks out, the call gets the verified extension (7 min total). "That was actually an OTP, a security check. Didn't feel like one, right? How was that?" Open question, and Voni lets them react.
7. **Close**: "I've passed my notes to the team; they'll follow up by email. Anything you'd like them to prepare?" The answer goes on the Prospect.

## Agent rules

- Never announce data collection. Every ask is a step in a test.
- Narration tracks the real tool state. Never say "sent" before the send succeeds.
- If the email is late, keep the business conversation going. At the provisional limit: "I'll reply the moment it lands," then close politely. The reply still goes out after the call.
- A claimed address that never produces mail means the call ends at the provisional limit and the code check cannot pass.
- Speak and write the reply in the picked language. The team summary is always English.
- v1 never asks for a phone number or WhatsApp.

## Prospect record (team-only)

Name, claimed email, verified flag, domain, website summary, what they do, prior tech use, ideas brainstormed, the intent answer, consent/no-marketing, language, transcript, and the AI session summary. The team views it on an admin page gated by `VONI_ADMIN_EMAILS`.

## Capabilities needed (implementation not yet chosen)

Facts:
- The demo agent has no tools. `voni/src/lib/demo/stored-agents.ts` sends none, and the `ToolCoordinator` exists only for inline calls in `voni/src/lib/voice/session.ts`.
- The 120s cap is baked into the token (`voni/src/app/api/demo/token/route.ts`).
- The repo has no email send or read; the Gmail tools in `voni/src/lib/providers/registry.ts` are catalog stubs.
- `leads` needs an org and a phone and has no email column.
- voni.cc does not resolve yet. The test inbox is nedalk.js@gmail.com via the Gmail API; full-inbox access is accepted.

Needed:
- Demo-agent tools: check the inbox for a sender, send the reply with the code, verify the code, fetch and summarize a website, extend the session, end the call.
- Session length: mint the token with a 7-min cap and enforce 2 → 4 → 7 on our side.
- A free-email domain list.
- A `prospects` table, an admin page, and the end-of-call summary.
- A copy chip in the call card (`voni/src/components/voice-call.tsx`), amending the transcript-only rule in `voni/DESIGN.md` §10c.

## Out of scope (v2)

- The "WhatsApp me" live test: the visitor messages first, so no Meta templates are needed. This is how the phone number gets captured.
- Moving the inbox to `test@voni.cc` via Cloudflare Email Routing once the domain is registered.
