# Voni press kit

Static brand masters. The in-product mark animates (the Classic loop: the arc
folds into the V and back); these files capture its resting state.

## Files

| File | Use |
|---|---|
| `voni-wordmark-light.svg` / `-dark.svg` | Full lockup, transparent. Light = dark ink (light surfaces), dark = light ink (dark surfaces) |
| `voni-mark-light.svg` / `-dark.svg` | Solo V mark, transparent |
| `voni-chip-light.svg` / `-dark.svg` | Rounded-square app icon |
| `voni-mono-black.svg` / `-white.svg` | Single-color reproduction (fax of the soul: print, engraving, single-ink) |
| `png/voni-wordmark-light-2048.png` | Dark ink on white, 2048w |
| `png/voni-wordmark-dark-2048.png` | Light ink on black, 2048w |
| `png/voni-chip-{light,dark}-{1024,512}.png` | App icon rasters |
| `png/voni-mark-{light,dark}-1024.png` | Solo mark rasters |
| `png/avatar-{1024,500,400}.png` | Square profile pictures (light chip — reads on light and dark feeds) |
| `png/og-cover-1200x630.png` | Social sharing cover |

SVG masters are canonical (infinite scale). PNGs are convenience rasters.

## Rules

- Clear space on all sides: at least the height of the arc.
- Minimum sizes: wordmark 96px wide, solo mark 24px, chip 32px.
- Don't stretch, recolor, outline, rotate, add shadows, or put light art on
  light surfaces (or dark on dark). The mono files exist for one-ink jobs —
  use those instead of recoloring.
- The wordmark's "oni" is live text (Geist with system fallback), not paths,
  so it stays editable. PNGs were rendered in real Geist.

## Regenerating

```bash
npx tsx scripts/press-raster.mts            # chip/mark/avatar PNGs (sharp)
npx tsx scripts/press-wordmark-shots.mts    # wordmark PNGs + OG (needs next dev + agent-browser)
```

Then delete `src/app/press-specimen/` and its manifest exclusion — the
scripts fail loudly on wrong dimensions, so a bad run can't ship quietly.
