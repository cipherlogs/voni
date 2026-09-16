# 03: Per-section pages with loading/error + form safety

**What to build:** Each section (account, voice copilot, workspace, services, appearance) loads its own data with a skeleton matching its layout and a route error state; editing then navigating preserves dirty inputs or explicitly warns instead of silently discarding.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Per-section loading skeletons shaped to real layout; per-section error state with retry
- [ ] Dirty-form protection explicit per form (retain-in-layout or confirm-on-leave)
- [ ] Owner-gating message preserved on workspace for non-owners
