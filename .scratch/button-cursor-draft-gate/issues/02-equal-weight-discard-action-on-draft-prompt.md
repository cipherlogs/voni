# 02: Equal-weight discard action on the draft prompt

**What to build:** On the agent creation page, when a saved draft triggers the continue-or-discard prompt, both actions render as visibly boxed buttons at the same size with matching hover frames — side by side on wide screens, stacked full-width on narrow screens — so hovering the discard action no longer makes it look smaller than the continue action. Choosing continue still resumes the saved draft where it was left off; choosing discard still clears the saved draft and restarts from a clean state. Keyboard focus indicators, touch target sizes, and screen-reader names and roles are unchanged.

**Blocked by:** 01: Native arrow cursor on shared button (this ticket's render-level test asserts the arrow cursor on both actions alongside frame parity).

**Status:** done

- [x] Both draft prompt actions render boxed at one shared size with matching hovered frames on wide and narrow layouts
- [x] Hovering either action does not make it appear smaller than its neighbor
- [x] Both actions show the native arrow cursor
- [x] Continue resumes the saved draft; discard clears it and restarts clean
- [x] A render-level test covers cursor styling, size/style parity, and the preserved continue and discard behaviors
- [x] Focus indicators, touch targets, and accessible names/roles are unchanged
