# README asset palette

Single source of truth for every generated asset under `docs/readme/assets/`.
If a figure, the banner, or the "built on" strip needs a colour, it comes from
here. No ad-hoc hex values.

## Brand accent

Voni's accent is the Tailwind green used by the product's logo arc
(`--color-green-600`). Do not substitute blue.

| Role | Token | Hex | Where |
|---|---|---|---|
| Accent ink on light | green-700 | `#008236` | Light-mode diagram accent text, arrows, emphasis |
| Accent ink on dark | green-500 | `#00c950` | Dark-mode diagram accent text, arrows, emphasis |
| Accent mark | green-600 | `#00a63e` | Logo arc, single-colour accent that works on both |

Contrast, measured:

- `#008236` on white 4.95:1 (AA for text)
- `#00c950` on `#0a0a0a` 8.93:1
- `#00a63e` on white 3.22:1 (not used for text at small sizes)

Do not use green-600 for accent text in light mode. It fails AA at diagram
label sizes. green-700 is the light-mode accent; green-500 is the dark-mode
accent. green-600 is only for shapes (the logo arc, a dot, a rule).

## Neutral ink

There is one ink scale, and light mode uses real black.

| Role | Light | Dark |
|---|---|---|
| Ink (headings, primary strokes) | `#0a0a0a` | `#f5f5f5` |
| Dim (secondary text, thin strokes) | `#4a4a4a` | `#a3a3a3` |
| Rule / hairline | `#0a0a0a` at 0.14 alpha | `#f5f5f5` at 0.14 alpha |
| Grid | `#0a0a0a` at 0.05 / 0.09 | `#f5f5f5` at 0.05 / 0.09 |

The previous light ink was `#1e1e1e` with `#6b6b6b` dim, which read as faded
grey. `#0a0a0a` with `#4a4a4a` is the fix: dim measures 8.86:1 on white, up
from 5.33:1.

## Fills

Highlight boxes and callout panels use a pale green wash in light mode and a
deep green in dark mode. Nothing uses blue.

| Role | Light | Dark | Ink on it |
|---|---|---|---|
| Soft fill (callout, highlighted box) | `#dcfce7` | `#052e16` | `#0a0a0a` / `#f5f5f5` |

Contrast: `#0a0a0a` on `#dcfce7` is 18.03:1. `#f5f5f5` on `#052e16` is 13.67:1.

The dark fill sits 1.33:1 against the `#0a0a0a` page, so it reads as a panel
without competing with the accent.

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
