# 08: Gallery cleanup + release gates

**What to build:** Throwaway gallery deleted, amendment finalized, banned-style greps clean, runtime loop check plus build/typecheck/lint/tests pass on desktop and 390px.

**Blocked by:** 03, 04, 05, 06, 07.

**Status:** ready-for-agent

- [ ] Gallery route and mock data fully removed; no dead links or nav entries
- [ ] Coherence greps clean except listed amendment exceptions
- [ ] Runtime loop verification per route (desktop + 390px, forced loading/error), zero errors; build + typecheck + lint + full test suite green
