# 06: Top bar removal with sidebar relocation

**What to build:** Top bar over the content is removed. Its search trigger, voice entry point, and jobs status move into the sidebar as rail-aware rows that collapse to icons. The voice panel re-anchors to the viewport corner. Section titles stay visible because every page already renders its own title. Command-menu and sidebar shortcuts keep working.

**Blocked by:** 01 (needs the new shell).

**Status:** ready-for-agent

- [ ] Dashboard layout renders no top bar on any route
- [ ] Search opens from the sidebar in both densities with shortcut intact
- [ ] Voice starts and stops from the sidebar with live state visible in both densities
- [ ] Jobs running and results-ready states stay globally visible from the sidebar
- [ ] Voice panel anchors clear of content on desktop and narrow screens
- [ ] Copilot manifest check stays green with titles resolved from their new home
- [ ] Orphaned top-bar module and its tests are updated or removed
