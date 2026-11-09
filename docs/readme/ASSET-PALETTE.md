# README asset palette

Single source of truth for every generated asset under `docs/readme/assets/`.
If a figure, the banner, or the "built on" strip needs a colour, it comes from
here. No ad-hoc hex values.

## Brand accent

Voni's accent is the Tailwind green used by the product's logo arc
(`--color-green-600`). Do not substitute blue.

| Role | Token | Hex | Where |
|---|---|---|---|
| Accent ink on light | green-800 | `#016630` | Light-mode diagram accent text, arrows, emphasis |
| Accent ink on dark | green-400 | `#05df72` | Dark-mode diagram accent text, arrows, emphasis |

Contrast, measured:

- `#016630` on white 7.13:1, and 6.49:1 on the pale green fill
- `#05df72` on `#0d1117` 10.64:1, and 8.38:1 on the deep green fill

Nothing uses green-600 `#00a63e` or green-700 `#008236` any more. green-700
cleared AA at 4.95:1, but on thin 12px handwriting strokes it still read as
soft, which is what the two darker steps fix.

## Neutral ink

There is one ink scale, and light mode uses real black.

| Role | Light | Dark |
|---|---|---|
| Ink (headings, primary strokes) | `#0a0a0a` | `#fafafa` |
| Dim (secondary text, thin strokes) | `#1f1f1f` | `#d4d4d4` |
| Rule / hairline | `#0a0a0a` at 0.14 alpha | `#f5f5f5` at 0.14 alpha |
| Grid | `#0a0a0a` at 0.05 / 0.09 | `#f5f5f5` at 0.05 / 0.09 |

The dim tier went through three values and stopped here. `#6b6b6b` read as
faded grey. `#4a4a4a` measured 8.86:1 on white and still read soft, because
these labels are 12 to 13px and drawn with a thin pen stroke. `#1f1f1f` is
16.48:1 and holds its weight at that size. Dark mode moved the same way, from
`#a3a3a3` to `#d4d4d4` (12.77:1 on `#0d1117`).

## Fills

Highlight boxes and callout panels use a pale green wash in light mode and a
deep green in dark mode. Nothing uses blue.

| Role | Light | Dark | Ink on it |
|---|---|---|---|
| Soft fill (callout, highlighted box) | `#dcfce7` | `#052e16` | `#0a0a0a` / `#f5f5f5` |

Contrast: `#0a0a0a` on `#dcfce7` is 18.03:1. `#f5f5f5` on `#052e16` is 13.67:1.

The dark fill sits 1.33:1 against the `#0a0a0a` page, so it reads as a panel
without competing with the accent.

## The app's own text

The same weight problem applied to the product, so two tokens in
`voni/src/app/globals.css` moved with it:

| Token | Was | Now | Contrast on its background |
|---|---|---|---|
| light `--muted-foreground` | `oklch(0.52)` | `oklch(0.38)` | 10.05:1, was 5.49:1 |
| dark `--muted-foreground` | `oklch(0.708)` | `oklch(0.8)` | 10.65:1, was 7.66:1 |

The screenshots in `assets/shots/` are captured after that change. Recapture
them if the token moves again.

## Shadows

None. Not in the banner, not in the figures, not in the screenshot
compositions, not in the app. Depth is carried by a 1px border and a
background step. A soft shadow on white reads as a smudge.

## Type

- Sans: `Geist, Inter, system-ui, -apple-system, sans-serif`
- Mono (labels, figure credits): `Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace`
- Hand-drawn figures: Virgil outlines, pre-converted to path data by
  `/tmp/sketchgen`. Do not add a font reference; a README cannot load one.

## Canvas

Transparent background in every SVG. GitHub supplies the page colour, and the
`<picture>` + `prefers-color-scheme` pair picks the variant. Never bake a
background into an SVG.
