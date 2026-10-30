# 153: Rollback rehearsal is a dated record

**What to build:** Before cutover, the operator flips routing off, confirms new calls route managed and live calls finish, and records the date, operator and evidence. The rehearsal is a record, not a memory.

**Blocked by:** 24 (Routing switch: off, demo, all)

**Status:** ready-for-human

- [ ] Routing is flipped off and new calls route managed.
- [ ] Live calls finish; the operator confirms it.
- [ ] The rehearsal is a dated artifact with the operator named.
- [ ] The rollback is a runtime switch, not a deploy.
- [ ] A missing rehearsal blocks cutover; a memory is not a record.
