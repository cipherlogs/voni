# 05: Website research and business talk

**Goal:** Voni actually knows what my business does from my website, tells me it's looking at it, and has a real, useful conversation about how it could help me. If I left to send the email, it has already read my site by the time I'm back.

**What to build:** A tool that fetches the website for the visitor's email domain and summarizes what the business does. Voni narrates it truthfully ("I'm looking at acme-realty.com right now…") and never claims to have read the site before it has.

The business-talk beat follows:
- what they do
- whether they've tried this kind of tech before
- where it could help
- concrete ideas brainstormed for their business

This is also how the wait for the email gets used. During Hold (02), Voni pre-reads the site of the most likely sender (Jev's best match from 03). So when the visitor returns and claims that address, Voni can say "I've already been through your site while you were away." If the claim doesn't match the pre-read sender, the normal flow runs. If the domain has no reachable website, Voni simply asks what they do.

**Blocked by:** 02 (Hold when the visitor leaves the page), 03 (Work-email claim and gate).

**Status:** built, awaiting the owner's real call

## Manual test (approve / reject)

1. Complete the claim with a work address whose domain has a real website. → Voni says it's looking at the site, then mentions something specific and correct about the business.
2. Talk about your business for a minute. → Voni asks about how leads reach you and whether you've used this tech, and suggests at least one concrete idea tailored to your business.
3. New call on your phone: leave for Mail, send the email, come back, claim the address. → Voni says it already went through your site while you were away and mentions something correct from it.
4. New call: claim an address whose domain has no website (or a parked domain). → Voni doesn't invent anything; it asks what you do.
5. Throughout: → Voni never says it read the site before it actually did (no made-up facts).

## Acceptance criteria

- [ ] The website fetch + summary tool works for the claimed domain, with a timeout and a graceful "no site" path.
- [ ] Truthful narration; no invented business details.
- [ ] Business-talk beat with tailored brainstorming.
- [ ] Pre-read during Hold for the likely sender; used on return only if the claim matches.
- [ ] Tests for the no-site path and the pre-read match/mismatch logic.

## Comments

**2026-09-29, build notes.** Owner decisions:
- Beat order: reply first, then the site while they grab the code.
- The read auto-starts once the email is found.
- 60s budget. Meta's summary measured 17–32s.
- The read is stored on `demo_calls` (migration 0014, applied to the dev DB by hand, like 0011/0013; other environments: run db:migrate).

How it runs:
- The call's `website` poll drives the read inline on the server. A Worker keeps `waitUntil` only ~30s.
- The reply's result says "already been through X", "looking at X now…" (a note follows), or asks what they do.
- Live smoke: basecamp.com gave a correct summary in 37s. Bot-blocked, parked, and missing domains all take the "none" path.

Known gaps:
- No pre-read while the page is frozen (iOS in Mail): no request comes in.
- A hold rejoin carries only spoken turns, not the summary.
- The site facts never reach Voni if no reply is sent.
