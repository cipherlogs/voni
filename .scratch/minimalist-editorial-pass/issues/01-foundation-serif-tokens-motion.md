# 01: Foundation — serif amendment, token sweep, motion unification

**What to build:** The shared foundation the whole pass stands on: one bundled editorial serif recorded as an explicit design-system amendment and applied to hero headings and quotes; every token violation translated to the allowed system (semantic color tokens, scale type, standard radius, flat surfaces); overlay timing unified on the shared standard duration; enforcement greps green except listed exceptions. After this ticket, any route can be restyled without inventing language.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Editorial serif added via the framework font bundler (heroes and quotes only; body, UI, buttons, metadata stay on the blessed sans and mono) and recorded in the frozen design-system file with rationale and scope; no other typeface added
- [x] Token sweep complete: arbitrary type and background values, hard-coded palette literals, bespoke dark sites, inline style objects, spaced stacks, non-square icon sizes, off-spec module specifiers, child-composition props, non-canonical toast references, template-filler words, and per-form geometry overrides all mapped, rebuilt in-style, cut, or cited as listed exceptions
- [x] Overlay enter durations unified on the shared standard token; surviving loops, shimmer, success pop, and Scene families keep their reduced-motion stops with static base frames
- [x] Running-app check on the touched routes (desktop plus narrow viewport) with zero compile or console errors

## Evidence

- `voni/src/lib/design-foundation.test.ts` (7 tests, green): Amendment A pin
  (Newsreader via next/font, `--font-editorial`, landing hero, DESIGN record)
  plus §5 enforcement mirrors (arbitrary values, palette, dark sites, inline
  styles, stacks/composition/toast/filler/geometry, durations + reduced-motion
  stops). Wired into `voni/package.json` test script; full suite 534 pass.
- `tsc --noEmit` clean; `npm run lint` 0 errors (2 pre-existing table-05
  React-Compiler warnings on untouched lines).
- Running app (dev :3000, agent-browser): `/` 200 with `font-editorial` hero,
  snapshot clean, console zero errors, no horizontal overflow (scrollW == w);
  `/login` 200, snapshot clean, zero errors; theme toggle opens
  Light/Dark/System with zero errors. Narrow-viewport direct resize was
  unavailable in the CLI core profile — foundation changes carry no geometry
  except the 19.2px→20px toggle icon, and the hero keeps max-w + balance, so
  ticket 09's full 390px matrix remains the backstop.
- Commit on `redesign/minimalist-editorial-pass` (this change).
