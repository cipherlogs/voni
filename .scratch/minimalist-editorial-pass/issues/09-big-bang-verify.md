# 09: Blocks-first verification across the whole app

**What to build:** Verify the converged app against existing product behavior, `voni/DESIGN.md`, and the pinned Blocks sources in that order. The mockup contributes rhythm only. Prove the sidebar files did not change, no top bar returned, route skeletons match their loaded layouts, system light and dark both work, and no non-approved custom visual pattern entered the app.

**Blocked by:** 02 (landing and auth), 03 (shell and dashboard), 04 (agents list and wizard), 05 (agent detail and campaigns), 06 (leads and calls), 07 (numbers, jobs, settings, operator), 08 (copilot, voice, feedback).

**Status:** in-progress

- [ ] Running-app loop per route (desktop plus narrow viewport, forced loading and error states) with zero compile, runtime, or console errors
- [ ] Production build plus preview build plus typecheck plus lint plus full test suite green with regenerated copilot manifest and updated UI-coupled tests
- [ ] Coherence audit: enforcement greps clean except listed exceptions, one canonical composition per area, retired exceptions absent
- [ ] Accessibility and motion review: reduced motion squashes loops to static frames, focus from tokens, live-call affordances distinct, keyboard parity on Tile actions; merge only when all gates pass
