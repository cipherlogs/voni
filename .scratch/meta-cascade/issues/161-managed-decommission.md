# 161: Decommission managed, after a recorded stability window

**What to build:** Removing the managed path is a separate, dated decision, never a side effect of cutover. It happens only after `routing=all` has held for an owner-recorded stability window, `off` has been proved to route a working product, and a deployable previous version exists as the real rollback.

**Blocked by:** 155 (Cutover to all eligible subjects), 148 (Rollback test), 153 (Rollback rehearsal is a dated record)

**Status:** ready-for-human

- [ ] The owner records the stability window (start, end, no rollback, no unresolved severity) and the evidence that `all` held.
- [ ] `routing=off` is proved to route a working managed product before managed is removed; the proof is a dated artifact.
- [ ] A deployable previous version is named as the rollback, because after removal `off` can no longer serve traffic.
- [ ] The decision names the date, the owner and the engineer, and is recorded where the cutover record can cite it.
- [ ] If the window is incomplete or a rollback occurred, managed stays; there is no early removal.
