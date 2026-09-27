# Voni press kit

Static brand masters. The in-product mark animates (the Classic loop: the V
opens into the arc and back); these files freeze its resting V phase so the
lockup always reads "Voni".

## Slogans

Canonical: **Every call ends with the work already done** (hero H1, footer,
metadata description). Alternates, for context-appropriate use:

- **One call, and everything after it.** (the loop)
- **The work happens while it's still talking.** (live execution)

The retired `It sees the lead. It seals the deal.` line must not appear in
new materials.

## Files

| File | Use |
|---|---|
| `voni-wordmark-light.svg` / `-dark.svg` | Full lockup, transparent. Light = dark ink (light surfaces), dark = light ink (dark surfaces) |
| `voni-mark-light.svg` / `-dark.svg` | Solo V mark, transparent |
| `voni-chip-light.svg` / `-dark.svg` | Rounded-square app icon |
| `voni-mono-black.svg` / `-white.svg` | Single-color reproduction (fax of the soul: print, engraving, single-ink) |
| `voni-lockup-work-done-{light,dark}.svg` | Wordmark + canonical slogan, transparent |
| `voni-lockup-everything-after-{light,dark}.svg` | Wordmark + loop alternate, transparent |
| `voni-lockup-while-talking-{light,dark}.svg` | Wordmark + live-execution alternate, transparent |
| `voni-lockup-{slug}-mono-{black,white}.svg` | Single-color slogan lockups for one-ink jobs |
| `png/voni-wordmark-light-2048.png` | Dark ink on white, 2048w |
| `png/voni-wordmark-dark-2048.png` | Light ink on black, 2048w |
| `png/voni-lockup-{slug}-{light,dark}-2048.png` | Slogan lockup rasters, 2048w |
| `png/voni-chip-{light,dark}-{1024,512}.png` | App icon rasters |
| `png/voni-mark-{light,dark}-1024.png` | Solo mark rasters |
| `png/avatar-{1024,500,400}.png` | Square profile pictures (light chip — reads on light and dark feeds) |
| `png/og-cover-1200x630.png` | Social sharing cover (wordmark, no slogan) |
| `png/og-{work-done,everything-after,while-talking}-1200x630.png` | Social sharing covers, one per slogan |

SVG masters are canonical (infinite scale). PNGs are convenience rasters.
(Mono lockups ship SVG only, like the mono wordmarks — no mono PNGs.)

## Rules

- Clear space on all sides: at least the height of the V.
- Minimum sizes: wordmark 96px wide, solo mark 24px, chip 32px, slogan
  lockup 120px wide (the slogan sets the floor, not the mark).
- Don't stretch, recolor, outline, rotate, add shadows, or put light art on
  light surfaces (or dark on dark). The mono files exist for one-ink jobs —
  use those instead of recoloring.
- The wordmark's "oni" and every slogan line are live text (Geist with
  system fallback), not paths, so they stay editable. PNGs were rendered in
  real Geist.
- One slogan per surface. Never stack two slogans in the same lockup.

## Regenerating

```bash
npx tsx scripts/press-raster.mts            # chip/mark/avatar PNGs (sharp)
npx tsx scripts/press-wordmark-shots.mts    # wordmark + lockup PNGs + OGs (needs next dev + agent-browser)
```

The shots script captures the disposable `src/app/press-specimen/` routes
(wordmark ×2, lockups ×6, OGs ×4). Recipe: copy
`scripts/press-specimen-page.src.tsx` to
`src/app/press-specimen/[shot]/page.tsx`, run the shots script against
`next dev`, then delete `src/app/press-specimen/`. The manifest generator
excludes `press-specimen` permanently, so no exclusion cleanup is needed.
The scripts fail loudly on wrong dimensions, so a bad run can't
ship quietly. To add a slogan: extend SLOGANS in the specimen source, add
route/out pairs in the shots script, add SVG masters, regenerate.
