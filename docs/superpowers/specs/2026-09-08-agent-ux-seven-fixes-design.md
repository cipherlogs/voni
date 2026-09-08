# Agent UX Seven Fixes — Design Spec

**Date:** 2026-09-08
**Scope:** `/agents/new` wizard, `/campaigns/[id]` import, `/leads/[id]` nav, header, design-system
**Decisions locked:** Remove LivePreview fully; header copilot replaces FAB; TTS sample preview; persist Both (spec + HANDOFF)
**Skills applied:** brainstorming (architectural), strategyUX, leanUX, everydayUX, lawUX
**Constraints:** shadcn on Base UI only (`render=`, never `asChild`); responsive async protocol (3s → durable job); `next-dev-loop` runtime verification after every app-code edit; read `voni/node_modules/next/dist/docs/` before App Router edits; `params` are Promises with typed `PageProps` helpers.

## 1. Progress bar + global pointer

**Problem → Evidence → Principle → Impact → Recommendation → Implementation → Validation**

Wizard `TimelineBar` (`voni/src/components/agent-wizard/wizard-timeline.tsx:93-142`) renders segments as `h-1.5` bars inside ghost Buttons. On desktop the visual target is 6px tall; hover gives no signifier except default arrow because `ui/button.tsx:7` base has no `cursor-pointer` and `rg cursor-pointer` = 0 hits repo-wide. everydayUX: affordance without signifier = hidden functionality. lawUX aesthetic-usability: polish hides poor affordance.

**Implementation:**
- `wizard-timeline.tsx` `TimelineBar`: segment to `h-2 md:h-2.5`, keep `rounded-full`, `done:bg-primary`, `active:bg-primary/40`, else `bg-muted`. Button wrapper keeps `p-1`, add `cursor-pointer hover:bg-muted` (already has hover), ensure `aria-current="step"`, `aria-label` with done/current suffix stay. `TimelineRail` Progress gets `className="h-2"`.
- `ui/progress.tsx`: keep `ProgressTrack h-1` default for slim header strip (`app-header.tsx:92-98`); allow override via className (already merges via `cn`).
- `ui/button.tsx` base: append `cursor-pointer` to base string. Keep `disabled:pointer-events-none`, keep `cursor-default` in `select.tsx`, `dropdown-menu.tsx`, sidebar resize handles. Do NOT add pointer to disabled.
- Global audit: `rg` for `onClick`, `<Button`, `<Link`, `role="button"`, `data-copilot-effect`, `PreviewSection`-style jump targets. Every interactive must show pointer + visible hover (`hover:bg-muted` / underline for text links like `campaigns/[id]/page.tsx:194-199` lead links which currently only `hover:underline` — add `cursor-pointer`) + `focus-visible` ring. `Badge` used as button (tasks preview `live-preview.tsx:99-103`) — after preview removal, ensure remaining badges are non-interactive or get button semantics.
- No `cursor-pointer` on plain text, cards, table rows unless clickable.

**Validation:** `rg cursor-pointer` covers button base; manual hover check at 1440 + 390; keyboard focus ring visible; 0 interactive elements with default arrow.

## 2. Remove LivePreview, consolidate at Review

LeanUX waste removal: `LivePreview` duplicates `ReviewStep` summary + adds maintenance (flash sync, jump focus, mobile Sheet).

**Implementation:**
- `agents/new/page.tsx`: delete `previewOpen` state, `previewCard`, `STEP_FOCUS` + `jump()` (replace with `wiz.setStep` direct), grid `lg:grid-cols-[minmax(0,1fr)_340px]` → single column `max-w-3xl`, delete right rail `div.hidden lg:flex`, delete `Sheet` preview block + `Eye`/`preview` button, delete `LivePreview` + `Sheet` imports. Keep `TimelineBar`, step bodies, Back/Continue, `ManualLlmGuidance`, `useOptimisticJob` generation flow unchanged.
- `ReviewStep` (`wizard-step-bodies.tsx:247-330`): extend `dl` summary rows to include per-row Edit buttons (`Goal → step 0`, `Persona → step 1`, `Tasks → step 2`) using ghost `sm` buttons with `cursor-pointer`; add `Progress` + `doneCount of 3 set` line (moved from preview); add Undo button when `canUndo`; keep `Generate agent` `LoadingButton`, `canGenerate` gate, `backgrounded` notice, error + template fallback. Props add: `flashed`, `canUndo`, `undoLabel`, `onUndo`, `onJump`.
- `live-preview.tsx`: delete file if no other importer (`rg LivePreview`). If `bare` used elsewhere, keep minimal or inline into Review.
- Copy update: header paragraph mentioning voice copilot stays; remove any "preview" wording.

**Validation:** steps 0-2 single column at 1440/390, no preview DOM; review shows goal/persona/tasks + progress + undo + generate; jump buttons focus correct field (`#new-goal`, `#new-name`, `#new-tasks`); voice flash still highlights edited section (now in review row, not preview card).

## 3. Import alignment + app-wide visual pass

`LeadImport` (`lead-import.tsx:113-151`): container `flex flex-wrap items-center gap-3`; left cell `grid gap-2` (Label + Input); button bare — vertically centers to label+input stack, not input.

**Implementation:**
- Change container to `items-end`. Wrap `LoadingButton` in `<div className="grid gap-2"><Label aria-hidden className="invisible select-none">Import</Label><LoadingButton .../></div>` so button baseline aligns to input. Alternative accepted: `pb-[26px]` spacer — prefer invisible label for grid consistency. Keep `flex-wrap` for 390px stacking; help text `p` stays full-width below via `basis-full` or existing flow (currently inline — move to `w-full` on wrap).
- Global audit + mandatory screenshots (owner requirement, not code-only): routes `/agents/new` (steps 0-3 + review + generated form), `/agents`, `/agents/[id]`, `/campaigns`, `/campaigns/new`, `/campaigns/[id]`, `/leads`, `/leads/[id]`, `/calls/[id]`, `/numbers`, `/jobs`, `/settings`, `/dashboard` at 390 / 768 / 1280 / 1440 × light/dark. Check: label/input/button baselines, card padding, table overflow (`overflow-x-auto` present on campaign queue — verify no double scroll), header truncation, JobPill overlap (layout already has `pb-[calc(var(--job-pill-h,0px)+2rem)]` — verify Save buttons clear it), no horizontal overflow (`document.scrollingElement.scrollWidth <= innerWidth`).
- Tooling: `next dev` running, `agent-browser` screenshots to `/tmp/ux-seven-*.png`, analyse images visually (not just DOM asserts), `next-dev-loop` skill per edit.

**Validation:** import button pixel-aligned to input at desktop; 0 overflow on all screenshots; dark mode borders visible.

## 4. Coherent back navigation

`/campaigns/[id]` has `Button render={<Link href="/campaigns">}` + `ChevronLeft` (`page.tsx:71-80`); `/leads/[id]` has none (`leads/[id]/page.tsx:18-27` starts at title).

**Implementation:**
- New `voni/src/components/back-link.tsx`: props `{href, label}`; renders ghost `sm` Button with `nativeButton={false} render={<Link href>}`, `className="-ml-2 w-fit"`, `ChevronLeft` + label, `cursor-pointer`. shadcn only.
- Apply: `/leads/[id]` → `{href:"/leads", label:"Leads"}`; `/agents/[id]` → Agents; `/agents/new` → Agents (alongside existing Back step button — keep both: wizard Back moves step, BackLink exits to list); `/calls/[id]` → Calls (verify route exists); `/campaigns/new` → Campaigns; audit `/numbers`, `/jobs`, `/settings` for detail states needing back.
- Placement: first element in page column, above title row. Label = parent section name (matches `SECTION_TITLES` in `app-header.tsx:27-36`).

**Validation:** every detail/new page has exactly one parent back link; click lands on parent list; screen-reader name = parent; no duplicate back controls in same view.

## 5. Voice copilot into header

Current: `CopilotShell` fixed bottom-right FAB (`copilot-shell.tsx:122-129`, `size-12`) + live pill + panel. Header (`app-header.tsx:57-90`) has Jobs button `ml-auto`.

**Implementation:**
- `AppHeader`: right cluster becomes `<div className="ml-auto flex items-center gap-1">` with `CopilotHeaderButton` + existing Jobs Button. `CopilotHeaderButton`: ghost `sm`, Mic icon + text (`Voice` idle / `…` connecting / `m:ss` live / `N ready` if proposals pending), `aria-label` mirrors FAB (`Start voice copilot` / `Connecting…` / `End voice call`), `onClick` = start/stop same as FAB, `cursor-pointer`. Live state shows timer (lift `elapsed` or subscribe to provider live tick — prefer provider `live` + local tick in header to avoid prop drilling).
- `CopilotShell`: remove fixed FAB container; keep panel + live call controls (mic/speaker/expand/end) but anchor as absolute dropdown under header button (or fixed top-right below `h-14` header). Remove `bottom: calc(var(--job-pill-h)+5rem)` positioning; keep `noteInteraction` handlers, `STATUS_TEXT`, proposal Apply/Dismiss flows, error + `RecoveryHint`. Ensure `z-50`, max-height, 390px width (`w-[min(24rem,calc(100vw-2rem))]` kept), JobPill (`bottom-left`) never overlaps.
- Delete FAB-specific ping animation or repurpose as live dot on header button. Keep `VoiceBars` mood indicator inside header button (small) or live pill.
- Imports: header becomes client component already (`"use client"` present); add `useCopilot` consumption — ensure `CopilotProvider` wraps `AppHeader` (it does in `dashboard/layout.tsx:41-42`).

**Validation:** start/stop/mute/panel/proposals from header at 390/1440; no bottom FAB in DOM; keyboard operable; panel doesn't cover Jobs button; timer ticks; quiet-session auto-end still works.

## 6. Tasks customizable + Goal compact

Goal starters (`wizard-step-bodies.tsx:106-148`) are full-width cards (`h-auto p-3` + outcome text) — vertical bloat. Tasks (`218-243`) are compact wrap chips but fixed `TASK_CHIPS` (5) with toggle only, no custom entry. Owner wants tasks customizable like goal, and goal compact like tasks.

**Implementation:**
- Goal: convert `STARTER_DEFS` cards to compact wrap chips: `size="sm" variant={applied?"secondary":"outline"}` showing `starter.title` only; `outcome` → `title` attr + `aria-describedby` tooltip; applied shows Check + `Applied` badge (keep). Keep custom `Textarea` below with label `Or describe your own goal`. Preserve `applyStarter` (goal + `suggestTasks` merge, dedup).
- Tasks: keep chips; add custom task row: `Input` (`id={idPrefix}-custom-task`, placeholder `e.g. Ask for preferred language`) + Add `Button` (`sm`, `cursor-pointer`). Add via `api.edit({tasks:[...draft.tasks, value]})` after trim, dedup case-insensitive, max 140 chars, max 12 tasks (show count `N/12`). Custom tasks render as removable badges (X button, `aria-label="Remove {task}"`) distinct from preset chips but same wrap container. Extend `WizardDraftApi` with `addTask`/`removeTask` or reuse `edit` + `toggleTask` (check `use-wizard-draft.tsx` — follow existing `edit`/`toggleTask`/`undo` history path so one Undo reverts).
- Voice: `wizardFieldSchema` already accepts free `value` for goal/tasks — ensure `wizardSummary`/`wizardKeyPhrases` handle custom strings; `composeBrief` unchanged (`tasks.join("; ")`).
- `use-wizard-draft.tsx`: no breaking change to `WIZARD_STEPS` order; `completed` logic include custom tasks (non-empty = complete).

**Validation:** goal chips wrap in one row group at desktop; custom task add/remove/undo works; voice "set tasks to X" proposes custom text; 12-task cap message; no layout shift.

## 7. Personality voice + language + live listen

`PersonalityStep` has name + vibe + 3 chips; voice/language only in post-generation `AgentConfigForm` (`agent-config-form.tsx:313-399`). Owner wants selection + live listen during wizard.

**Implementation:**
- Draft model (`use-wizard-draft.tsx` + `starters.ts` `composeBrief`): add `voiceId: string` (default `"anna"`) + `languageCodes: string[]` (default `[]`). `composeBrief` unchanged (voice not in LLM brief). `draftRef`/`applyAgentPatch` support new keys. Copilot `wizardFieldSchema` field enum add `"voice"`, `"languages"` (or reuse `personality`? prefer explicit fields); `wizardSummary` phrases: `Set voice to {label}` / `Listen for {langs}`; target reader exposes voice/language.
- UI (`PersonalityStep`): after personality chips, add Voice group (same `voicesByLanguage()` + `voiceLabel` + `ACCENT_LABEL` as review form, `size="sm"` wrap buttons, `cursor-pointer`, selected `variant="default"`), each with Play sample button (`aria-label="Preview {voice}"`, `Play`/`Square` icon, `h-7 w-7` icon button). Add Languages group (same `INPUT_LANGUAGES` flags + labels, multi-toggle, auto-detect hint copy, understands-only badge, mismatch warning when selected lang has no voice).
- Live listen: short TTS sample, no mic. On Play: `POST /api/voice-preview` (new, or reuse `/api/demo/token` + `VoiceSession` if exists — prefer new minimal route returning short audio buffer for `voiceId` + greeting sample `"Hi, this is {agentName || 'Voni'}. Can you hear me okay?"`). Client: `AudioContext` play, button → `Playing…` disabled + `stop()` on switch/unmount/second tap. Errors: missing AssemblyAI key → inline Alert with Settings link; 429 → countdown copy (match `voice-call.tsx` pattern); network → retry. Never auto-play on select (explicit Play only — avoids surprise audio + cost).
- Review + save: `ReviewStep` persona row shows `name · personality · voiceLabel`; `agents/new/page.tsx` `save()` maps `wiz.draft.voiceId/languageCodes` into `AgentConfig` passed to `createAgentAction` (check `AgentConfigForm initialConfig` merge — wizard draft voice wins over generated draft voice unless user edited post-generation; define: wizard selection is source of truth, generation result voice overwritten).
- Files: `lib/voice/voices.ts` (existing `getVoice`, `voicesByLanguage`, `voiceLabel`, `INPUT_LANGUAGES` — reuse, no fork); new `app/api/voice-preview/route.ts` (Zod `{voiceId, text}`, 15s cache, 280-char cap, creator-scoped rate limit); client hook inline in step body (no new global provider).

**Validation:** select voice → Play → hear sample → switch stops prior; languages multi-select persists to saved agent (`agents/[id]` shows same voice/langs); no-key and 429 states show distinct copy; TTS never fires without tap.

## Architecture

Single-column wizard (review owns summary); design-system base owns cursor; `BackLink` owns parent nav; header owns copilot entry; draft model owns voice/langs end-to-end (wizard → review → save). No new global state except draft fields; no new job types (preview is short interactive, not durable).

## Data flow

Wizard draft (`useWizardDraft`) → `composeBrief` (goal/name/personality/tasks only) → `agent_generation` job → `AgentConfig` + wizard `voiceId/languageCodes` → `createAgentAction` → `/agents/[id]`. Voice preview: step → `/api/voice-preview` → audio buffer → `AudioContext` (ephemeral, no persistence).

## Error handling

Per `voni/AGENTS.md` visual protocol: `LoadingButton` pending + disabled; inline `Alert` for validation/blocking; `sonner` toast for fire-and-forget; per-item pending (task remove, voice play) not shared boolean; `loading.tsx`/`error.tsx` unchanged (no new awaiting Server Components except preview route which returns JSON).

## Testing

`tsc --noEmit`, `eslint`, `npm test` (add: draft voice/langs defaults + brief excludes voice; task add/dedup/cap; starter chip apply; back-link hrefs; header copilot labels), `get_compilation_issues` + `get_errors` empty, `agent-browser` screenshots + `next-dev-loop` per edit, 0 horizontal overflow asserts, keyboard-only pass for wizard/header/panel.
