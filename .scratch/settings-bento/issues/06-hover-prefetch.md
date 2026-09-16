# 06: Hover-intent route prefetch

**What to build:** Hovering or keyboard-focusing a tile prefetches only that route so the click lands instantly, while the landing itself stays fast with no viewport fetch avalanche.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Landing links defer prefetch until hover/focus intent; viewport does not prefetch all tiles
- [ ] Prefetch fires once per intent; keyboard focus prefetches exactly like hover
- [ ] Click after hover lands instantly in production build behavior
