# 01: Floating shell swap with workspace nav

**What to build:** App rail becomes the floating icon-collapsible block shape with existing destinations, active highlighting, collapse trigger plus shortcut, and open-by-default with remembered choice. Demo notifications content cut; motion dependency rejected in favor of existing tokens.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Rail uses floating icon-collapsible shape with block gaps and paddings
- [x] Row hover and active states use the existing accent token (no muted token exists)
- [x] Collapsed rail uses the default icon width (no wide override)
- [x] Every existing destination renders with icon, label, and active state
- [x] Collapse trigger and keyboard toggle work; first visit open, choice remembered
- [x] No motion dependency added; no demo commerce routes or notifications
- [x] Shared navigation source still feeds rail, command menu, and voice guide
