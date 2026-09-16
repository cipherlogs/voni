# 05: Notifications bell on jobs plus calls data

**What to build:** Sidebar header carries a bell with a count, fed by running and newly finished jobs from the existing jobs provider plus recent calls from a new org-scoped recent-activity endpoint. Opening the bell clears the unread state. No demo notification data ships and no ambient polling is added.

**Blocked by:** 01 (needs the header slot).

**Status:** ready-for-agent

- [ ] Bell shows a text count with accessible naming and tooltip in both densities
- [ ] Jobs section lists running and newly finished jobs with status and links
- [ ] Calls section lists recent calls with who and when plus detail links
- [ ] Opening the bell marks currently-unread jobs seen
- [ ] Calls endpoint is org-scoped, returns display-safe columns only, 401 when signed out
- [ ] Empty state reads as caught-up, never as broken
