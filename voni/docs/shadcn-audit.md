# Voni shadcn audit — findings and disposition

> Concrete component findings + disposition. Base UI / Base Nova / colors / typography / logo / density / responsive structure preserved. `@/components/ui` aliases + Lucide kept. No `init`, preset change, Radix migration, or `--all --overwrite`.

## Baseline (Task 1, 2026-09-09)

- `voni/src/components/ui`: alert, avatar, badge, breadcrumb, button, card, dialog, dropdown-menu, input, label, progress, select, separator, sheet, sidebar, skeleton, sonner, switch, table, tabs, textarea, tooltip (22 files).
- Plan expected "23 incl. Sidebar, Skeleton, Card, Dialog, Sheet, Sonner" — reconcile exact count in Task 13 (`npx shadcn@latest info --json` from `voni/`).
- Composition: Base UI `render=` (not `asChild`); `nativeButton={false}` where Button renders anchor (known house pattern).
- Expected additions (plan): Field, Input Group, Toggle Group, Empty, Toast, chat components for transcript UI + registry-selected deps.
- Known candidate inventories (verify in context, not blind grep): raw Label/control wrappers, ungrouped menu/select items, `space-x/y` stacks, manual dark overrides, raw voice-call button colors, non-`size-*` squares, non-`cn()` conditionals, missing `data-icon`, Sonner call sites, manual conversation scroll effects.

## Findings

| # | Location | Issue | Rule | Disposition | Status |
|---|---|---|---|---|---|
| 1 | `ui/label,separat,button,input,textarea` | Registry `field` install wanted `cn`-from-`cn` import churn + dropped `cursor-pointer` from Button base | aliases preserved | Reverted all 5 overwrites; kept 11 new files (field, input-group, toggle-group+toggle, empty, toast, message-scroller, message, bubble, attachment, marker) | done |
| 2 | mode-toggle, phone-numbers, campaign-form, settings-view, operator-view selects | `SelectItem` outside `SelectGroup` | Items inside groups | Wrapped in `SelectGroup` | done |
| 3 | mode-toggle theme items | `DropdownMenuItem` outside group | Items inside groups | Wrapped in `DropdownMenuGroup` | done |
| 4 | 8 form files | Raw `div.grid+Label` wrappers | FieldGroup+Field | Converted (names/IDs/values/validation/payloads preserved; window/days errors → FieldError) | done |
| 5 | campaign days (7), agent voice groups, agent channels (2) | Manual active-state button loops | ToggleGroup 2–7 | Converted (invariants kept: min-1 channel, required voice) | done |
| 6 | wizard voice preview pairing, goal/personality chips, 18 languages, consent select | Bounded-set candidates | selective | Kept: wizard rebuild forbidden + preview-action pairing; chips are fill shortcuts; 18 > 7; consent is a proper Select | exception recorded |
| 7 | record-results, operator-view | `space-x/y` stacks | flex gap | Converted | done |
| 8 | connection-test emerald, voice-call red/brand, mode-toggle dark:, voni-logo hex | Raw colors / dark: overrides | semantic tokens | Exceptions: no `success` token in base-nova; hang-up solid-red is safety affordance (destructive here is a tint, per code comment); toggle/logo are theme mechanics/brand graphics | exception recorded |
| 9 | Square icons `h/w` pairs | Equal dims | `size-*` | Converted (11 sites); Button-contained icon sizes dropped where primitive auto-sizes | done |
| 10 | `data-icon` | No `data-icon` selectors in base-nova Button CSS | icons rule | Upstream exception: primitive auto-sizes bare SVGs; adding inert attributes rejected | exception recorded |
| 11 | All `toast.*` call sites + root Toaster | Sonner usage | Base UI toast | Migrated to `toast.add` (texts/descriptions/actions/IDs/dedup preserved, `toast.close` on action); sonner component + dep removed after 215/215 tests | done |
| 12 | Dialogs/sheets | Title check | accessible titles | No app-code Dialog/Sheet usages — nothing to fix | verified none |

## Upstream exceptions (verified primitive internals, not app violations)

_None yet. Record separately per plan; do not mechanically rewrite upstream internals on grep match._

## Verification

Each install/fix: official `@shadcn` search → CLI docs/examples read → preview affected files → explicit install → review generated files/deps/aliases/composition → runtime page check (next-dev-loop).
