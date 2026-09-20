# Scoped brand green for bento signals; containment replaces bleed

Ticket 01's scenes shipped all-graphite with key elements deliberately clipped per its occupancy rule; review found only the Services scene readable. We extended the logo-V green (`--color-green-600`) to scenes as narrowly-scoped `.bento-signal-*` classes (same precedent as voice-call's live classes — still not a global token, never body text), restricted to traveling/moment elements, and replaced the bleed rule with containment (key glyphs never clipped, 16px inset floor).

## Considered Options

- **New global `--brand`/`--accent` color token**: rejected — `globals.css` explicitly bans reintroducing one, and a global would leak green into chrome the design system keeps monochrome.
- **Keeping the bleed rule with smaller overflow**: rejected — review showed clipping itself, not its amount, destroyed readability.
