# 09: Big-bang verify — gates across the whole app

**What to build:** The merge gate for the full pass: every route runtime-checked, builds and suite green, coherence greps clean, one canonical composition per area, accessibility and motion reviewed — the single point where big-bang green is promised.

**Blocked by:** 02 (landing and auth), 03 (shell and dashboard), 04 (agents list and wizard), 05 (agent detail and campaigns), 06 (leads and calls), 07 (numbers, jobs, settings, operator), 08 (copilot, voice, feedback).

**Status:** ready-for-agent

- [ ] Running-app loop per route (desktop plus narrow viewport, forced loading and error states) with zero compile, runtime, or console errors
- [ ] Production build plus preview build plus typecheck plus lint plus full test suite green with regenerated copilot manifest and updated UI-coupled tests
- [ ] Coherence audit: enforcement greps clean except listed exceptions, one canonical composition per area, retired exceptions absent
- [ ] Accessibility and motion review: reduced motion squashes loops to static frames, focus from tokens, live-call affordances distinct, keyboard parity on Tile actions; merge only when all gates pass
