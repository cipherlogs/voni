# 03: Footer, jobs badge, and session preservation

**What to build:** Footer stacks a single-workspace switcher above the existing account menu; jobs pending count with accessible naming survives in both densities as a corner pill when collapsed.

**Blocked by:** 01 (needs the new shell).

**Status:** done

**Resolution note:** the single-workspace switcher was deleted outright (no file, no import — test-pinned) rather than stacked, which satisfies "no fake multi-team data" strictly. Footer is `SidebarAccount` + session note, operator stays reachable at `/operator` in the account menu, jobs status survives in the utility row in both densities.

- [x] ~~Single-workspace switcher entry above account~~ — deleted outright instead (see note); no fake multi-team data
- [x] Account menu with name, email, settings, and sign out stays working
- [x] Jobs count badge on jobs row with accessible name and tooltip in both densities
- [x] Operator entry remains reachable for platform admins
