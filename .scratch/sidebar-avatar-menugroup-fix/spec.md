Status: done

**Resolution:** no ticket breakdown needed — every story verified already implemented and test-pinned, so decomposing would manufacture dead work. Single-identity footer (`SidebarAccount` or session-note text, `team-switcher.tsx` deleted), collapsed avatar centered with email tooltip, account menu (name/email once, settings, conditional `/operator`, sign-out with pending state + failure toast that leaves the session intact), labels-inside-groups with the `MenuGroupContext` rationale comment, unified last-resort error delegating to `RouteError` with `retry`, bell stories retired with ticket 05 (wontfix — bell deleted by user pick). Pins live in `voni/src/components/sidebar-redesign.test.ts` (13/13 green).

## Problem Statement

I open the dashboard sidebar and see two stacked identity blocks in the footer — a workspace switcher above my account menu — which no user expects in a single-workspace product. Worse, clicking many sidebar controls (team switcher, notifications bell, and potentially other dropdowns) crashes the dashboard into an error page reading "Base UI: MenuGroupContext is missing", and that error page looks different from the app's unified error card, so a sidebar interaction failure feels like a different app breaking.

## Solution

Make the dashboard sidebar footer show exactly one identity — the signed-in account menu — by fully removing the workspace switcher concept from the sidebar, since there is only one workspace and no switching backend. Fix every sidebar dropdown so its menu label lives inside the menu group it names (the Base UI group-label contract), eliminating the MenuGroupContext crash on open. Unify the last-resort error boundary with the shared route error card so any residual failure renders the same in-style message plus retry affordance. Verify with a top-to-bottom click-through of every sidebar target across all dashboard routes, densities, viewports, and themes, with typecheck and the full test suite green.

## User Stories

1. As a signed-in dashboard user, I want exactly one identity block in the sidebar footer, so that I am never confused about which row opens my account.
2. As a single-workspace user, I want no workspace switcher row, dropdown, shortcut hint, or add-team affordance anywhere in the sidebar, so that dead controls never waste my attention.
3. As a keyboard and screen-reader user, I want the removed switcher to leave no focusable trace, orphaned label, or tooltip, so that the footer tab order is just the account menu.
4. As a collapsed-rail user, I want the single account avatar centered in its target with its tooltip intact, so that the narrow rail stays discoverable.
5. As a dashboard user, I want to open the notifications bell without crashing, so that I can triage job results and recent calls.
6. As a dashboard user, I want the bell to list running and newly finished jobs first with working links, so that I can jump to what needs review.
7. As a dashboard user, I want the bell to list recent calls with direction, name, and relative time, so that I can jump to call detail.
8. As a dashboard user, I want opening the bell to settle the unread count, so that the badge means something unseen.
9. As a dashboard user, I want to open the account menu without crashing, so that settings, operator (when entitled), and sign-out stay reachable.
10. As a dashboard user, I want the account menu to show my name and email once, with settings and sign-out actions, so that session controls stay put.
11. As a platform admin, I want the operator entry to remain reachable from the account menu, so that admin access is not regressed.
12. As a signing-out user, I want a pending state and a failure toast that leaves me signed in on error, so that sign-out never silently dies.
13. As a dashboard user, I want every main nav destination to navigate without landing on an error boundary, so that the rail is trustworthy.
14. As a dashboard user, I want the current section highlighted on list and detail pages, so that I always know where I am.
15. As a background-jobs watcher, I want the pending count on the jobs row with accessible naming and tooltip, so that status is never icon-only.
16. As a collapsed-rail user, I want the jobs count to survive as a corner pill, so that I do not miss running work.
17. As a search user, I want the rail search row to open the command menu via click and keyboard shortcut, so that navigation never depends on a top bar.
18. As a command-menu user, I want workspace destinations plus new-agent, new-campaign, settings, and conditional operator entries to route correctly, so that the rail and search never disagree.
19. As a voice-copilot user, I want the rail voice row to start and stop with clear labeling and disabled-until-ready behavior, so that tapping voice is unambiguous consent.
20. As a jobs follower, I want the rail jobs status row to link to the jobs queue with live progress, so that ambient status is one tap from its retry path.
21. As a brand viewer, I want the expanded lockup when open and the square mark when collapsed, with instant light and dark swap, so that identity reads correctly in every density and theme.
22. As a mobile user, I want the full lockup in the drawer plus working collapse, bell, nav, utility rows, and account menu, so that the sheet is fully usable at full width.
23. As a motion-sensitive user, I want only the existing width transition with reduced-motion respected, so that expand and collapse stay calm.
24. As a dashboard user, I want any residual sidebar or route failure to render the unified error card with message plus retry, so that failures feel like one app explaining itself.
25. As a dashboard user, I want retry from the error card to actually re-attempt the failed segment, so that transient failures are recoverable without reload.
26. As a rate-limited or permission-blocked user, I want a distinct message rather than a generic failure, so that I know whether to wait, retry, or ask for access.
27. As a maintainer, I want no new dependencies, palette entries, or motion primitives from this fix, so that design-system bans hold.
28. As a developer adding a route, I want one navigation source feeding rail, command surface, and voice manifest, so that I cannot update one and forget the others.
29. As a developer adding a future dropdown, I want the group-label contract pinned by tests, so that this crash class cannot regress silently.

## Implementation Decisions

- The sidebar footer becomes single-identity: the workspace switcher module is deleted outright (not hidden behind a flag), including its single-workspace copy path, shortcut hints, and add-team branch. The footer retains the user-gated account menu and the unauthenticated session-note text. No workspace-switching backend is introduced.
- Every sidebar dropdown menu label is placed inside the menu group it names, per the established Radix-to-Base-UI migration rule that a standalone group label throws. The account menu already follows this structure and is kept as the reference pattern; the notifications bell menu is brought into the same structure. Grouping carries the accessible name; no visual redesign is introduced.
- Dropdown menu items that navigate continue to compose the menu item with the router link primitive; action-only items (sign-out, voice start/stop, search trigger, collapse toggle) remain href-free with correct pending and disabled states. No navigation behavior changes beyond crash removal.
- The last-resort error boundary adopts the shared route error presentation (alert plus retry affordance with the current-generation retry callback name, optional backoff countdown support) inside its required document shell, so segment-level and app-level failures read as one system. Per-route error segments keep delegating to the shared error component unchanged.
- The collapsed icon rail, floating variant, remembered open-or-closed bit, suspense-isolated active-link highlight, and provider ordering (auth before jobs before voice before sidebar) are preserved unchanged. Badge, tooltip, and accessible-name behavior for jobs and voice rows is preserved in both densities.
- Proposed test seams (highest first, existing preferred — please confirm these match expectations): (1) running-app browser seam via the dev server plus framework diagnostics and the browser click-through loop as the primary external-behavior gate; (2) the existing sidebar contract test module as the pin for single-identity footer shape and grouped-label structure; (3) typecheck plus the full repo test suite as the regression gate. Ideal seam count is one (the running sidebar); seam two exists only to prevent silent reintroduction of the deleted module or an ungrouped label.

## Testing Decisions

- A good test asserts external behavior, not implementation details: menus open without entering an error boundary; footer exposes exactly one identity control; labels are announced via accessible group structure; navigation lands on the intended destination; retry re-attempts the failed segment. Source-text pattern tests are acceptable only as regression pins for the deleted module and the label-inside-group rule, mirroring existing prior art.
- Modules under test: sidebar shell footer composition (single account identity, no switcher residue); notifications bell open plus job and call row navigation plus unread settling; account menu open plus settings, conditional operator, and sign-out pending and failure paths; full nav destination traversal; rail utility rows (search trigger, voice start and stop gating, jobs status link); unified error presentation for segment and last-resort boundaries.
- Prior art to extend: the existing sidebar redesign contract test module (footer shape, bell data behavior, rail tokens, jobs badge semantics); the shared error component usage across dashboard error segments; framework diagnostics (current errors, route inventory, on-demand route compilation) plus the browser dev-loop pass (DOM snapshot, console errors, component tree, pending boundaries) as the runtime evidence gate.
- Matrix: every dashboard destination crossed with expanded rail, collapsed icon rail, and mobile drawer, in light and dark themes, with zero console errors and zero error-boundary entries. Typecheck clean and the full suite green at the pre-existing baseline count.

## Out of Scope

- Any visual redesign of the sidebar, bell, menus, brand assets, tokens, spacing, or motion beyond crash removal and switcher deletion.
- Multi-workspace switching backend, team management, invitations, or permissions model changes.
- New routes, new nav destinations, sub-route information architecture, or command-menu result ranking changes.
- Voice pipeline, jobs execution semantics, recent-activity endpoint shape, auth session resolution, or telemetry changes.
- Production theming migration, licensed avatar sourcing, or short-viewport layout refinements noted elsewhere.
- Silent patching of behavior on failure: any behavior change must surface via the unified error presentation and test evidence.

## Further Notes

- This is a regression of a previously fixed crash class: the group-label contract was established when the account menu was fixed, and later menus reintroduced the standalone-label shape. The contract test update should make reintroduction fail loudly.
- The reporter's observation that restarting the dev server might help is noted but not relied upon: the crash reproduces from menu structure on open, independent of server state. A restart is still the first step of the runtime verification pass.
- Deletion is deliberate per reporter direction ("don't just hide it"): no feature flag, no commented-out switcher, no retained single-team copy path. Future multi-workspace work should reintroduce the concept from scratch against a real backend.
- Verification leaves the dev server running and changes reviewable; commit scope stays limited to the sidebar modules, the error boundary presentation, and their contract tests.
