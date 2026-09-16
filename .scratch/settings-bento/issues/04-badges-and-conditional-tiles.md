# 04: Live tile badges + conditional tiles

**What to build:** Landing tiles show truthful live status from the existing readiness summary; numbers tile always shows, operator tile hides entirely for non-admins.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Each tile shows a live badge (e.g. Connected/Needs setup/current theme) from existing data, no per-tile fetch avalanche
- [ ] Operator tile hidden unless platform admin; never a disabled dead end
- [ ] Badges verified by screen reader as part of link announcement
