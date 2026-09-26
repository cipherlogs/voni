# 06: Prospect record, consent + close, admin page

**Goal:** After a full demo call, I open the admin page and see the visitor as a Prospect: name, verified email, what their business does, what they want, whether we may follow up, and a short summary. The call ended with Voni asking consent at the happy moment.

**What to build:** Every demo call that reaches a claim creates a **Prospect**, updated as the call goes. It holds:
- name, claimed email, verified flag, domain
- website summary, what they do, prior tech use, ideas brainstormed
- the intent answer
- consent / no-marketing
- language, off-track warnings
- transcript and an English AI summary written at the end of the call

After the reveal, while the visitor is enjoying it, Voni asks the consent line: "Glad you liked it. Mind if the team follows up at andres@acme-realty.com?" A "no" marks the Prospect no-marketing. Then comes the close: "I've passed my notes on. Anything you'd like them to prepare?" The answer is saved as the intent.

A team-only admin page lists Prospects, newest first, and opens one to show all the fields. Access is limited to the existing platform admin emails. Visitors never see any of this.

**Blocked by:** 04 (Code check and reveal).

**Status:** ready-for-agent

## Manual test (approve / reject)

1. Do a full call: claim, code check, reveal. → After the reveal Voni asks if the team may follow up at your address. Say yes. → Voni asks what you'd like them to prepare. Answer something specific.
2. Open the admin page signed in as an admin. → Your Prospect is at the top with name, verified email, domain, business summary, your intent answer, consent = yes, language, and an English summary that matches the call.
3. New call: say "no" to follow-up. → That Prospect shows no-marketing.
4. New call: get gated for gmail. → Whether it appears or not matches the rule (a Prospect exists only once a channel was shared); it is clearly unverified.
5. Open the admin page signed in as a non-admin, then signed out. → Access denied in both cases.

## Acceptance criteria

- [ ] Prospect storage kept separate from customers' leads, created at claim and updated through the call.
- [ ] Consent line after the reveal; "no" → no-marketing. Close with the intent question saved.
- [ ] English AI summary written at call end (including for calls that end early after a claim).
- [ ] Admin-only list and detail pages; non-admins and signed-out users are blocked.
- [ ] Tests for Prospect creation/updates, consent flags, and admin gating.
