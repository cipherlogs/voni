# Agent UX Seven Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship all 7 agent/campaign/lead/header UX fixes with screenshot proof and no regressions.

**Architecture:** Foundation first (button cursor, progress sizing, BackLink) then wizard consolidation (preview removal, goal/tasks, personality voice) then header copilot move, each with tsc/lint/tests plus agent-browser screenshots.

**Tech Stack:** Next.js 16 App Router, shadcn on Base UI (`render=`, never `asChild`), Tailwind, AssemblyAI voice, `agent-browser`, `next-dev-loop` skill.

**Spec:** `docs/superpowers/specs/2026-09-08-agent-ux-seven-fixes-design.md`

## Global Constraints

- shadcn components only, Base UI `render={<Component/>}` composition, never `asChild`.
- Non-interactive work over 3s is a durable job (`voni/src/lib/jobs/`), never spinner-only.
- After every app-code edit, verify at runtime with `next-dev-loop` skill (compile + browser).
- Before App Router edits, read `voni/node_modules/next/dist/docs/` version-matched guide.
- `params`/`searchParams` are Promises; use `PageProps<'/route'>` typed helpers.
- Screenshots mandatory: 390/768/1280/1440 × light/dark for every touched route; inspect images, not DOM alone.
- `tsc --noEmit`, `eslint`, `npm test`, MCP `get_compilation_issues` + `get_errors` empty per task.

---

### Task 1: Button cursor + TimelineBar sizing

**Files:**
- Modify: `voni/src/components/ui/button.tsx:7`
- Modify: `voni/src/components/agent-wizard/wizard-timeline.tsx:118-124,81`
- Test: `voni/src/components/agent-wizard/wizard-timeline.test.tsx` (new or extend)

**Interfaces:**
- Consumes: existing `cn`, `WIZARD_STEPS`, `Progress`.
- Produces: all `Button` instances show pointer; `TimelineBar` segments `h-2 md:h-2.5`.

- [ ] **Step 1: Write failing test**

```tsx
// wizard-timeline.test.tsx
import { render, screen } from "@testing-library/react";
import { TimelineBar } from "./wizard-timeline";
test("segments are pointer + sized", () => {
  render(<TimelineBar current={0} completed={[false,false,false,false]} onSelect={()=>{}} />);
  const btns = screen.getAllByRole("button");
  expect(btns[0].className).toMatch(/cursor-pointer/);
  expect(document.querySelector(".h-2")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd voni && npm test -- wizard-timeline -v`
Expected: FAIL (no cursor-pointer, h-1.5 only)

- [ ] **Step 3: Implement**

```tsx
// ui/button.tsx base: append " cursor-pointer"
// wizard-timeline.tsx segment span: "h-2 md:h-2.5 w-full rounded-full ..."
// TimelineBar Button: add "cursor-pointer"
// TimelineRail Progress: className="h-2"
```

- [ ] **Step 4: Run tests + tsc + lint**

Run: `cd voni && npm test -- wizard-timeline -v && npx tsc --noEmit && npm run lint`
Expected: PASS, clean

- [ ] **Step 5: Screenshot + commit**

Run: screenshots `/agents/new` 1440 + 390, inspect hover/focus. Then:
```bash
git add voni/src/components/ui/button.tsx voni/src/components/agent-wizard/wizard-timeline.tsx
git commit -m "fix: pointer cursor on buttons, larger wizard progress"
```

### Task 2: Global pointer audit

**Files:**
- Modify: various (add `cursor-pointer`, `hover:underline` where missing)
- Test: manual `rg` + screenshots

- [ ] **Step 1: Audit**

Run: `cd voni && rg -n "onClick|<Button|<Link|role=\"button\"" src --glob '*.tsx' | head -120`
Expected: list of interactives; flag any without pointer/hover/focus.

- [ ] **Step 2: Fix missed affordances (lead links, badges, jump buttons)**

```tsx
// e.g. campaigns/[id] lead Link: className="hover:underline cursor-pointer"
```

- [ ] **Step 3: Verify + commit**

Run: screenshots spot-check 5 routes; `npx tsc --noEmit`
```bash
git add -A && git commit -m "fix: global clickable affordances show pointer"
```

### Task 3: Remove LivePreview, enhance ReviewStep

**Files:**
- Modify: `voni/src/app/(dashboard)/agents/new/page.tsx:52,71,310-317,356-454`
- Modify: `voni/src/components/agent-wizard/wizard-step-bodies.tsx:247-330`
- Delete: `voni/src/components/agent-wizard/live-preview.tsx` (if orphan)
- Test: wizard draft + review render tests

- [ ] **Step 1: Write failing test**

```tsx
test("review shows edit jumps + progress + undo", () => {
  render(<ReviewStep ... />);
  expect(screen.getByText(/of 3 set/)).toBeTruthy();
  expect(screen.getAllByRole("button", {name:/Edit/}).length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to fail**, **Step 3: Implement** (single-column `max-w-3xl`, delete `previewCard`/`Sheet`/`STEP_FOCUS`, extend ReviewStep props with `flashed/canUndo/undoLabel/onUndo/onJump`, per-row Edit buttons, Progress, Undo), **Step 4: tests+tsc**, **Step 5: screenshots + commit**

```bash
git add voni/src/app/\(dashboard\)/agents/new/page.tsx voni/src/components/agent-wizard/
git commit -m "refactor: remove live preview, consolidate at review step"
```

### Task 4: LeadImport alignment

**Files:**
- Modify: `voni/src/components/lead-import.tsx:113-151`

- [ ] **Step 1: Fix to `items-end` + invisible label spacer**

```tsx
<div className="flex flex-wrap items-end gap-3">
  <div className="grid gap-2">...Input...</div>
  <div className="grid gap-2">
    <Label aria-hidden className="invisible select-none">Import</Label>
    <LoadingButton ...>Import selected CSV</LoadingButton>
  </div>
  <p className="w-full ...">...</p>
</div>
```

- [ ] **Step 2: Screenshot `/campaigns/[id]` 1440/768/390 light/dark, verify pixel alignment, commit**

```bash
git add voni/src/components/lead-import.tsx
git commit -m "fix: align import button to input baseline"
```

### Task 5: BackLink + rollout

**Files:**
- Create: `voni/src/components/back-link.tsx`
- Modify: `leads/[id]/page.tsx`, `agents/[id]/page.tsx`, `agents/new/page.tsx`, `calls/[id]/page.tsx`, `campaigns/new/page.tsx`

- [ ] **Step 1: Create component**

```tsx
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
export function BackLink({href,label}:{href:string;label:string}) {
  return <Button nativeButton={false} render={<Link href={href} aria-label={`Back to ${label}`} />} variant="ghost" size="sm" className="-ml-2 w-fit cursor-pointer"><ChevronLeft aria-hidden />{label}</Button>;
}
```

- [ ] **Step 2: Add to leads/[id] + others, screenshots, commit**

```bash
git add voni/src/components/back-link.tsx voni/src/app/\(dashboard\)/
git commit -m "feat: coherent back navigation app-wide"
```

### Task 6: Header copilot replaces FAB

**Files:**
- Modify: `voni/src/components/app-header.tsx:52-99`
- Modify: `voni/src/components/copilot/copilot-shell.tsx:122-129,283-310`
- Test: copilot provider/shell tests

- [ ] **Step 1: Header button with Mic + text + timer; shell panel re-anchored top-right; FAB removed. Verify start/stop/mute/proposals at 390/1440, commit**

```bash
git add voni/src/components/app-header.tsx voni/src/components/copilot/copilot-shell.tsx
git commit -m "feat: voice copilot in header, remove floating FAB"
```

### Task 7: Goal compact + Tasks customizable

**Files:**
- Modify: `voni/src/components/agent-wizard/wizard-step-bodies.tsx:88-243`
- Modify: `voni/src/components/agent-wizard/use-wizard-draft.tsx`, `starters.ts`, `wizard-tools.ts`

- [ ] **Step 1: Goal cards → wrap chips; tasks add Input+Add (trim/dedup/140-char/12-cap) + removable badges; voice schema handles custom; tests for add/dedup/cap; screenshots; commit**

```bash
git add voni/src/components/agent-wizard/
git commit -m "feat: compact goal chips, customizable tasks"
```

### Task 8: Personality voice + language + TTS sample

**Files:**
- Modify: `use-wizard-draft.tsx`, `starters.ts`, `wizard-tools.ts`, `wizard-step-bodies.tsx:165-216`, `agents/new/page.tsx:save`
- Create: `voni/src/app/api/voice-preview/route.ts`
- Test: draft defaults, brief excludes voice, preview route Zod + cap

- [ ] **Step 1: Draft `voiceId="anna"`, `languageCodes=[]`; step UI reuses `voicesByLanguage()`/`INPUT_LANGUAGES` + Play sample via `/api/voice-preview` (`{voiceId,text≤280}` → audio); stop on switch/unmount; distinct no-key/429 copy; review row + save mapping; screenshots + device listen; commit**

```bash
git add voni/src/components/agent-wizard/ voni/src/app/api/voice-preview/
git commit -m "feat: personality voice+language with live sample"
```

### Task 9: Full screenshot matrix + final gates

- [ ] **Step 1: Capture 13 routes × 4 widths × 2 themes to `/tmp/ux-seven-*.png`, inspect each image, log fixes**
- [ ] **Step 2: Run `npx tsc --noEmit`, `npm run lint`, `npm test`, MCP `get_compilation_issues` + `get_errors`**
- [ ] **Step 3: Commit matrix log + update HANDOFF**

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-08-agent-ux-seven-fixes.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - dispatch fresh subagent per task, review between tasks

**2. Inline Execution** - execute tasks in this session with checkpoints

**Which approach?**
