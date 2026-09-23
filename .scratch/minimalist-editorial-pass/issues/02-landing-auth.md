# 02: Landing and auth in the editorial language

**What to build:** The public face of the product: a calm landing hero (tight-tracking serif headline, plain-language subcopy, live-demo widget integrated into the composition, feature Tile grid with generous padding and crisp hairlines) and auth screens sharing the same type, spacing, and footer language, all on the section-whitespace rhythm with constrained type measure.

**Blocked by:** 01 (foundation — serif amendment, token sweep, motion unification).

**Status:** done

- [x] Landing hero reads as one document composition: badge, serif headline, subcopy, and live-demo widget with session gate, suspense boundaries, and demo-mode voice wiring unchanged
- [x] Feature Tile grid uses flat card tokens, ring hairlines, generous padding, and bottom-anchored content; no hype copy, no placeholder names, no primary-color fills
- [x] Auth screens follow the pinned login idiom around the existing single-sign-on logic (session decisions untouched) at the narrow auth width with shared footer language
- [x] Running-app check on landing, login, and signup (desktop plus narrow viewport, forced loading and error states) with zero compile or console errors

## Evidence

- `voni/src/lib/landing-auth.test.ts` (3 tests, green): hero composition
  (badge, font-editorial, tracking-tight, balance, constrained measure,
  demo max-w-2xl, session gate + Suspense + demo wiring frozen), Tile grammar
  (bg-card, ring hairline, p-8, gap-6, mt-auto, motion-standard hover, no
  primary fills/hype/filler), auth idiom (session decisions untouched,
  Login01 + Google social + narrow width, shared SiteFooter language).
  Wired into `voni/package.json` test script; full suite 537 pass.
- `voni/src/components/site-footer.tsx` (new): shared brand mark + tagline
  + year slot on the shared PUBLIC_CONTAINER gutter; landing/auth render
  the same language. Auth screens import the shared FooterYear
  request-time leaf (no per-route copy), so the PPR shell stays
  prerenderable (build lists /login + /signup as PPR).
- `voni/src/components/auth-decision.tsx` (new): single session decision
  for login + signup (session, next-path, bypass, redirect, OAuth error
  mapping); routes stay thin frames behind their Suspense boundaries.
- Card primitive already speaks ring-1 ring-foreground/10 with no border
  class, so the explicit Tile ring dedupes via cn() to one crisp hairline.
- `tsc --noEmit` clean; `npm run lint` 0 errors (2 pre-existing table-05
  React-Compiler warnings on untouched lines); §5 greps clean except listed
  survivors; production build green (exited 0 with 8GB heap; default 2GB
  heap OOMs in the TS phase on this repo).
- Running app: dev :3000 `/` desktop + 390px snapshots clean, zero console
  errors, no overflow; prod preview (`npm run preview` from `voni/`, bypass off) `/login` +
  `/signup` render AuthForm + shared footer with zero errors, forced error
  states via ?error= show the Alert copy, 390px signup no overflow.
