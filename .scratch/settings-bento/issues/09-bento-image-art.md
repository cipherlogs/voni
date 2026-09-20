# 09: Bento image art direction (replate scenes)

**What to build:** Use the built-in `imagegen` workflow to art-direct tile scenes: generate comps per tile, review them against the endpoint-grammar contract, then replate the CSS scenes with the winning direction. The generated images are design references; the shipped scenes remain React, SVG, and CSS. Appearance goes first because no CSS option won.

## Decision method

Check each comp against the frozen endpoint grammar and visual gates. After generating the comps, change `Status` to `needs-info` and wait for the user to pick the winners. Once the picks are recorded, return the ticket to `ready-for-agent` for the replate. Keep TypeSafe/JEV dependencies, credentials, and evaluators outside this ticket because Jev cannot inspect the generated images directly.

**Blocked by:** 08 (feature complete first; art replates onto the shipped landing).

**Status:** done

- [x] Endpoint-grammar contract frozen (flows + endpoints from 01b winners; rendering open)
- [x] `imagegen` comps generated and agent-reviewed against the endpoint and signal contracts
- [x] User-picked winners recorded
- [x] Scenes replated to winning direction; amendment updated with new rendering rules
- [x] Same gates: containment, signal grammar (or amended successor), reduced-motion frames, 390px, zero filler words

## Comp review

The seven three-option boards are indexed in [`../comps/README.md`](../comps/README.md). Options `A`, `B`, and `C` are the left, center, and right panels. The selected directions below drove the production replate.

## Selected directions

- Appearance B
- Services A
- Voice copilot A
- Account B
- Workspace A
- Phone numbers A
- Platform operator C
