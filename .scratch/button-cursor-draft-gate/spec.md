Status: done

**Resolution:** both tickets closed — 01 implemented (`ba2896de`, suite green), 02 pre-existing and verified. See issue notes.

## Problem Statement

When I hover over buttons anywhere in the app, the mouse pointer turns into a hand, which is not the standard look for buttons and makes the UI feel off. Separately, on the agent creation page, when I have a saved draft and see the "continue draft" prompt, the "discard and start fresh" button looks smaller than the "continue draft" button next to it when I hover over it, which looks broken.

## Solution

Buttons everywhere show the native default arrow cursor on hover instead of the hand pointer. The hand pointer stays only on true link-like and expandable affordances (underlined links, expandable disclosure rows), where it is expected. On the agent creation draft prompt, the discard action becomes a visibly boxed outlined button at the same size as the continue action, so both buttons have matching hover frames.

## User Stories

1. As a signed-in user, I want buttons to show the default arrow cursor on hover, so that the UI matches standard button behavior I expect from other apps.
2. As a signed-in user, I want the primary continue action on the draft prompt to show the arrow cursor, so that it behaves like every other button.
3. As a signed-in user, I want the discard action on the draft prompt to show the arrow cursor, so that both choices feel like equal-weight buttons.
4. As a signed-in user, I want disabled buttons to look disabled (dimmed and non-interactive) without a hand cursor, so that I can tell at a glance they cannot be clicked.
5. As a signed-in user, I want underlined links to still show the hand cursor, so that I can tell they are links.
6. As a signed-in user, I want expandable disclosure rows to still show the hand cursor, so that I can tell they expand.
7. As a returning agent creator with a saved draft, I want the draft prompt to offer continue and discard actions that look like equal choices, so that I trust neither option is broken.
8. As a returning agent creator, I want the discard button's hovered frame to match the continue button's hovered frame in height and presence, so that hovering does not make either button appear to shrink.
9. As a returning agent creator on a narrow screen, I want both draft prompt actions to stack full-width and keep matching frames, so that the choice is clear on mobile.
10. As a returning agent creator on a wide screen, I want both draft prompt actions to sit side by side at the same height, so that the choice reads as one balanced row.
11. As a returning agent creator, I want clicking continue to resume my saved draft where I left off, so that choosing the bigger-looking button does not silently change behavior.
12. As a returning agent creator, I want clicking discard to clear my saved draft and restart the wizard from a clean state, so that the new outlined styling does not change what discard does.
13. As a keyboard-only user, I want both draft prompt actions to keep visible focus indicators, so that I can tell which action is focused.
14. As a keyboard-only user, I want button focus and activation behavior to be unchanged by the cursor fix, so that my workflow is not disrupted.
15. As a touch user with no hover, I want both draft prompt actions to be tappable at the same size as before, so that the fix does not shrink touch targets.
16. As a screen-reader user, I want both draft prompt actions to keep their accessible names and roles, so that the visual fix does not change what I hear.
17. As a developer adding a new button, I want the shared button styling to default to the arrow cursor with no extra work, so that I cannot accidentally reintroduce the hand.
18. As a developer running the test suite, I want the existing variant assertions updated to the new expectation, so that the suite stays green and documents the intended cursor behavior.

## Implementation Decisions

- The shared button style definition is modified so its base no longer requests the hand pointer cursor; every button variant (default, outline, secondary, ghost, destructive, link-styled) inherits the native arrow cursor with no per-variant overrides.
- The pointer cursor is deliberately retained on true link-like and disclosure affordances (underlined links, expandable summary rows), which keep their existing behavior unchanged.
- Disabled-button affordance continues to come from dimming plus non-interactive behavior, not from any cursor change.
- The draft prompt's discard action switches from the borderless ghost style to the visibly boxed outlined style; its size scale, layout classes, and responsive stacking behavior are unchanged, so both actions share one size and one boxed presence.
- The public variant/size interface of the shared button is unchanged: no new variants, no renamed props, no changed defaults besides the cursor and the single discard-action style swap.
- No schema, API-contract, or wizard-logic changes: continue still resumes the cached draft, discard still clears the cache and resets the wizard to a fresh state.
- The two existing unit tests that pin the old pointer-cursor expectation are updated to assert its absence; this is a mechanical expectation flip, not a behavior redesign.
- No domain-glossary or decision-record changes: cursor styling and button-style parity are UI mechanics, not domain vocabulary or hard-to-reverse architecture.

## Testing Decisions

- A good test here asserts externally observable behavior (rendered cursor-related styling on button actions; both draft-gate actions sharing one size scale with the discard action using the boxed outlined style; continue/discard still performing resume/clear-plus-reset), not internal implementation details.
- One seam covers the change: a render-level test for the draft prompt exercising both actions (cursor styling, size/style parity, preserved continue and discard behaviors), keeping the seam count at the ideal one.
- The two pre-existing shared-variant assertions are updated in place to the new expectation and serve as regression coverage for the cursor removal.
- Prior art for the tests: the existing unit tests that assert on the shared button variant's base styling, and the wizard test suite's established pattern of asserting on rendered/source-level markers for draft-cache behavior.

## Out of Scope

- Cursor behavior of non-button controls (switches, tabs, sidebar items) is unchanged.
- Cursor behavior of true links and disclosure affordances is unchanged.
- Any change to wizard step logic, draft caching, generation flow, or the responsive stacked-vs-side-by-side layout beyond the single style swap.
- New button variants, design-system restyling, or focus-ring redesign.
- Domain glossary or decision-record writes.

## Further Notes

- Seams used: one new render-level seam for the draft prompt plus mechanical updates to the two existing shared-variant assertions; flag if a different seam placement is preferred before implementation starts.
- Runtime verification should open the agent creation draft prompt and compare both actions' hovered frames side by side, plus spot-check button hover cursors elsewhere.
