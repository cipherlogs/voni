# 03: Work-email claim and gate

**Goal:** When I email Voni from a work address during the call, Voni finds my email in the busy inbox, greets me by name, and gives me more time. If I use gmail, it politely turns me away.

**What to build:** The invite beat: "send me an email from your work address and watch how fast I handle it." The call card shows the test inbox address as a tap-to-copy chip, with a `mailto:` link on phones. This amends the transcript-only rule for the call card in the design system, so record that amendment. Voni says the address once.

After the visitor says they've sent it (or returns from Hold), Voni asks the claim question: "I'm getting lots of emails, from you and others testing me. To keep everyone's data safe, which address did you use?" Then:

- **Business domain:** the provisional extension (talk clock to ~4 min). Voni greets them by the name visible in the address, or asks for it lightly later.
- **Free-email domain** (a plain domain list, no model): the work-email gate. Voni asks "Do you have a work email? We only work with verified businesses." If they have none: "No problem. Reach the team at hi@voni.cc and we'll gladly look into it," then a polite end.
- **Refusing to send any email:** the stakes ladder from 01.

The server reads the test inbox (nedalk.js@gmail.com for now). A Jev judge picks which recent email belongs to this caller: it compares the spoken address, allowing for speech-to-text near-misses, with each sender and the arrival time. It also flags spoof or spam. If the email hasn't arrived by the provisional limit, Voni says "I'll reply the moment it lands" and closes politely.

**Blocked by:** 01 (Voni as itself: tools, talk clock, stakes ladder).

**Status:** ready-for-agent

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
