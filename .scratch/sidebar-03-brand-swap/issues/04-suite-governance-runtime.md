# 04: Behavior suite, governance, and runtime gate

**What to build:** Extended sidebar behavior suite green, design record amendment plus third-party attribution, full checks plus runtime loop on dashboard desktop and narrow widths in both themes.

**Blocked by:** 01, 02, 03, 05, 06.

**Status:** done

**Resolution:** behavior suite green (`sidebar-redesign.test.ts` 13/13; full suite 527/527; `tsc` clean), design record pins the block in `voni/DESIGN.md` with attribution in `voni/THIRD-PARTY-NOTICES.md`, live Playwright loop 15/15 loads 200 with zero console/page errors and zero error markers (desktop 1280 + 390px, light + dark; `calls/loading`, `calls/error`, `calls/[id]/error` present with Next 16 `retry`). Caveat: loop ran unauthenticated (Google-only auth has no automation session), so the signed-in shell visual rests on static contract pins, not screenshots.

- [x] Sidebar behavior suite asserts new shell, brand densities and themes, nav mapping, badge survival, bell data sources, relocated search/voice/jobs, absent top bar, and motion-dependency absence
- [x] Design record pins the block with upstream commit plus floating choice, notifications cut, single-workspace footer, and motion rejection
- [x] Typecheck, lint, and full test suite green; runtime loop passes desktop plus narrow in both themes
