Status: done

**Resolution:** all six tickets resolved — 01/03/06 done, 02 done-superseded (Classic logo amendment), 05 wontfix (bell removed by user pick), 04 done with runtime loop. See issue notes.

## Problem Statement

I love the floating sidebar-03 look and want it as my app sidebar. My current rail uses a hard-coded inline mark with no proper expanded lockup versus collapsed mark and no light and dark sets, so branding reads wrong in one theme or one density. I want sidebar-03 adoption with my logo swapped in, sizes respected, loading open by default.

## Solution

Adopt the full sidebar-03 block structure with its floating icon-collapsible shell, header brand slot plus collapse trigger, main navigation list, and footer switcher, wired to the existing workspace destinations and account. Swap the demo logo for a four-asset brand set covering expanded versus collapsed crossed with light versus dark, rendered with a class-strategy theme swap inside the same size slot upstream uses. Keep open-by-default with the remembered user choice, and drop the upstream motion dependency in favor of existing motion tokens. The sidebar header carries a notifications bell fed by real data (finished and running jobs plus recent calls). The top bar over the content is removed: search, voice, and jobs status move into the sidebar, and each page already carries its own title.

## User Stories

1. As a dashboard user, I want the sidebar to load expanded on first visit, so that I see full navigation labels immediately.
2. As a dashboard user, I want to collapse the rail to icons and expand it again from the header trigger, so that I control density.
3. As a dashboard user, I want my collapse choice remembered across reloads, so that I do not re-collapse every visit.
4. As a keyboard user, I want the existing toggle shortcut to keep working, so that I can collapse without a mouse.
5. As a dashboard user, I want the expanded brand lockup in the header when open, so that I see the full identity.
6. As a dashboard user, I want the square brand mark when collapsed, so that identity survives in the narrow rail.
7. As a light-mode user, I want the light expanded lockup and light collapsed mark, so that the brand reads correctly on light surfaces.
8. As a dark-mode user, I want the dark expanded lockup and dark collapsed mark, so that the brand never renders as a stray light square.
9. As a theme switcher, I want the logo pair to swap instantly with no reload, so that theme changes feel native.
10. As a mobile user, I want the full lockup in the drawer, so that the sheet brands correctly at full width.
11. As a workspace user, I want every existing destination with its icon and label present, so that nothing is lost in the swap.
12. As a workspace user, I want the current section highlighted, so that I know where I am.
13. As a background-jobs watcher, I want the pending count badge on the jobs row with accessible naming and tooltip, so that status is never icon-only.
14. As a collapsed-rail user, I want the jobs count to survive as a corner pill, so that I do not miss running work.
15. As a signed-in user, I want my account menu with name, email, settings, and sign out in the footer, so that session controls stay put.
16. As a workspace member, I want a single-workspace switcher entry above the account, so that the block footer shape is kept without fake multi-team data.
17. As a screen-reader user, I want brand imagery decorative with one accessible dashboard label, so that I hear no logo babble.
18. As a collapsed-rail user, I want icon tooltips with labels, so that the rail stays discoverable.
19. As a motion-sensitive user, I want only the existing width transition with reduced-motion respected, so that expand and collapse stay calm.
20. As a command-menu user, I want the shared navigation source unchanged, so that shortcuts and search keep working.
21. As a voice-copilot user, I want the navigation source for the app guide unchanged, so that spoken guidance still matches the rail.
22. As a platform admin, I want the operator entry to remain reachable, so that admin access is not regressed.
23. As a maintainer, I want no new motion dependency and no demo notification or team data, so that design-system bans hold.
24. As a maintainer, I want the floating variant with its content gaps and paddings intact, so that the result looks like the block throughout.
25. As a developer adding a route, I want one navigation source feeding both the rail and the command surface, so that I cannot update one and forget the other.
26. As a dashboard user, I want a notifications bell in the sidebar header with a count, so that I see job completions and recent calls without opening a page.
27. As a dashboard user, I want the bell to list unfinished and newly finished jobs first with links, so that I can jump to what needs review.
28. As a dashboard user, I want the bell to list recent calls with who and when, so that I can jump to call details.
29. As a dashboard user, I want opening the bell to clear the unread state, so that the count means something unseen.
30. As a dashboard user, I want search, voice, and jobs status inside the sidebar, so that no top bar is needed.
31. As a voice user, I want the voice panel anchored where I can reach it without a top bar, so that live calls stay usable.
32. As a keyboard user, I want command-menu and sidebar shortcuts unchanged with no top bar, so that my workflow is not disrupted.
33. As a dashboard user, I want each page to keep its own visible title, so that removing the top bar never leaves me lost.

## Implementation Decisions

- The app sidebar shell is replaced with the full block composition: floating icon-collapsible shell, header brand slot plus collapse trigger plus notifications bell, main navigation component, footer switcher. Demo commerce routes, demo notification content, and demo multi-team list are not adopted.
- Row hover and active states use the existing accent token, since the theme carries no muted token and no new palette is introduced. The collapsed rail returns to the default icon width.
- The existing flat workspace destination list is mapped into the block route shape with no sub-routes initially; sub-route support stays available for later without changing the shell.
- The brand ships as four vector assets covering the two resolved dimensions: expanded lockup versus collapsed mark, each with light and dark variants. The collapsed variant is a square mark and the expanded variant is a wider horizontal lockup sharing one height slot with contain-fit, preserving upstream geometry.
- Theme switching uses a class-strategy image swap with the light pair visible by default and the dark pair in the dark theme. No theme-reactive inline hex remains in the sidebar.
- The upstream motion dependency is rejected per the frozen design mandate; the header trigger cluster uses a plain container with the existing standard-duration transition. Any surviving brand loop reuses already-allowed keyframes only.
- Open-by-default behavior is preserved with the existing remembered open-or-closed bit applied on mount only when present; the mobile drawer keeps its own independent open state and the header trigger plus keyboard toggle keep working.
- Active-route highlighting keeps its suspense-isolated boundary so links prerender without active styling and the highlight streams in; the session-gated account area keeps its static shape above the auth boundary.
- The durable-jobs ambient count badge with accessible naming and tooltip is ported into the new nav row in both densities, so the collapsed pill behavior is preserved.
- The header bell reads running and newly finished jobs from the existing jobs provider (marking them seen on open) and recent calls from a new org-scoped recent-activity endpoint that returns display-safe columns only, fetched lazily on open. No ambient polling is added and no demo notification data ships.
- The footer stacks a single-workspace switcher entry above the existing user-gated account menu; no workspace-switching backend is introduced.
- The top bar is removed from the dashboard layout. Its search trigger, voice entry point, and jobs status move into the sidebar as rail-aware rows; the voice panel re-anchors to the viewport corner; the section-title constant moves with the copilot manifest generator to its new home; every page already renders its own title so none is added.
- The shared navigation export remains the single source for the rail, the command menu, and the voice guide, so all three stay consistent.
- The shared primitives layer is untouched; vendored block files live with other blocks, composition uses render-prop triggers throughout, icons stay in the canonical set, and no new palette, arbitrary values, or cursor or shadow inventions are introduced.
- Governance: design record amendment pinning the block with its upstream commit, noting the floating variant choice, the notifications cut, the single-workspace footer, and the motion-dependency rejection; third-party attribution retained.

## Testing Decisions

- A good test here asserts externally observable behavior (expanded shows the lockup, collapsed shows the mark, correct light versus dark pair visible, open by default with toggle persistence, every destination renders with active state, jobs count visible in both densities with accessible naming, no motion dependency), not internal styling strings or file locations.
- One seam covers the change: the existing sidebar behavior suite extended to the new shell (brand densities and themes, floating variant, navigation mapping, jobs badge survival, motion-dependency absence, bell data sources, relocated search/voice/jobs, absent top bar), keeping the seam count at the ideal one.
- The dashboard shell default-open plus restore behavior is covered by that suite unless it proves insufficient, in which case a layout-level test is added as a second seam.
- Prior art for the tests: the existing sidebar redesign assertions for expanded wordmark versus collapsed centering, the jobs-badge assertions for count math plus accessible label plus collapsed pill, and the command-menu assertions that pin the shared navigation source.

## Out of Scope

- Final brand artwork production beyond placeholder vectors; art swap later is asset-only.
- New destinations, sub-navigation content, or information-architecture changes.
- Mobile drawer redesign beyond the brand slot.
- Auth, jobs queue, copilot, table, form, or landing changes.
- Build, hosting, schema, or API-contract changes.
- Glossary or decision-record writes beyond the single design amendment above.

## Further Notes

- Seams used: one extended sidebar behavior suite; flag if a different seam placement is preferred before implementation starts.
- Runtime verification should cover the dashboard at desktop and narrow widths in both themes: default expanded with full lockup, collapse to the square mark, toggle persistence across reload, and jobs badge in both densities.
