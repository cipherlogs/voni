# 02: Bento landing + dynamic section shell with real navigation

**What to build:** `/settings` becomes a registry-driven bento landing and each tile links to a real child route served by one dynamic section shell with static params; deep links work, unknown sections render not-found, legacy hashes redirect.

**Blocked by:** 01 (winner pick from gallery review).

**Status:** ready-for-agent

- [ ] Landing maps over registry; tiles are real links with shareable URLs; single-column on mobile
- [ ] Dynamic child route serves all sections via static params; unknown value renders not-found
- [ ] Shared shell preserves heading/skeleton across section navigation
- [ ] Old tab state machine removed from landing path once routes land
