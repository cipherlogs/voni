# 02: Four-state brand swap in header slot

**What to build:** Demo logo replaced by expanded lockup versus collapsed mark crossed with light versus dark set, with instant theme swap inside the same size slot upstream uses. Drawer shows the full lockup.

**Blocked by:** 01 (needs the header brand slot).

**Status:** done

**Resolution:** superseded by DESIGN.md amendment 2026-09-16 — the four-asset light/dark image swap was retired in favor of the animated Classic `BrandLogo` (`sidebar-03/logo.tsx`: `VoniMark` loop expanded, static `voni-chip-in` chip collapsed, theme via `currentColor` + tokens, no assets). Density-appropriate brand, theme-correct rendering, decorative imagery, and drawer lockup are covered and test-pinned (`sidebar-redesign.test.ts`); do not re-implement the four-asset swap.

- [ ] Expanded open rail shows wide lockup; collapsed rail shows square mark
- [ ] Light theme shows light pair; dark theme shows dark pair with no flash
- [ ] Brand slot keeps upstream height with contain-fit and no layout shift
- [ ] Brand imagery decorative with one accessible dashboard label
- [ ] Mobile drawer shows full lockup
