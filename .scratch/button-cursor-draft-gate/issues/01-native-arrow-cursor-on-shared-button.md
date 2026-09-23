# 01: Native arrow cursor on shared button

**What to build:** Hovering any button in the app shows the native default arrow cursor instead of the hand pointer, matching standard button behavior. Disabled buttons remain visibly dimmed and non-interactive with no hand cursor. True link-like and expandable disclosure affordances keep the hand pointer exactly as today.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Hovering buttons across all variants shows the native arrow cursor, never the hand
- [x] Disabled buttons are dimmed and non-interactive with no hand cursor
- [x] Underlined links and expandable disclosure rows still show the hand cursor
- [x] The pre-existing shared-variant assertions are updated to the new expectation and the suite is green
- [x] A newly added button gets the arrow cursor with no extra styling work
