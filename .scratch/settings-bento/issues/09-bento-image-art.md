# 09: Bento image art direction (replate scenes)

**What to build:** Use the built-in `imagegen` workflow to art-direct tile scenes: generate comps per tile, review them against the endpoint-grammar contract, then replate the CSS scenes with the winning direction. The generated images are design references; the shipped scenes remain React, SVG, and CSS. Appearance goes first because no CSS option won.

## Decision method

Check each comp against the frozen endpoint grammar and visual gates. After generating the comps, change `Status` to `needs-info` and wait for the user to pick the winners. Once the picks are recorded, return the ticket to `ready-for-agent` for the replate. Keep TypeSafe/JEV dependencies, credentials, and evaluators outside this ticket because Jev cannot inspect the generated images directly.

**Blocked by:** 08 (feature complete first; art replates onto the shipped landing).

**Status:** ready-for-agent

- [ ] Endpoint-grammar contract frozen (flows + endpoints from 01b winners; rendering open)
- [ ] `imagegen` comps per tile reviewed; user-picked winners recorded
- [ ] Scenes replated to winning direction; amendment updated with new rendering rules
- [ ] Same gates: containment, signal grammar (or amended successor), reduced-motion frames, 390px, zero filler words
