# 01 — Playwright fullscreen verifier (robust, no retries)

Status: resolved
Type: task

## Goal

Provide the single agentic verifier the loop runs after every edit. It must fail while phone fullscreen is broken and pass only when popup + backdrop independently match the visual viewport.

## Acceptance

- `npm run test:mobile:takeover` exits 0 on green, non-zero with JSON dump on red.
- 390×844: dialog + backdrop rects equal `visualViewport` (±1px), `x=0 y=0`, no horizontal reveal, scroll locked, transcript has height, no system-context row, backdrop/Escape never dismiss, Close restores orb + focus to Start.
- 1280×800: mobile dialog absent, desktop card intact.
- Zero retries; polling for settled rects instead. Fake mic granted so no permission prompt flakes.
- Live mute (listening/speaking Mute→Unmute, hidden context, agent audio continues) is MANUAL — user tests on phone, agent never marks it done alone.

## Comments

- Created after user report: cannot test on phone, fullscreen broken. Verifier drives the loop.
- 2026-09-25: verifier green in emulation — `{"ok":true,"vv":{"w":390,"h":844},"popup":{"x":0,"y":0,"w":390,"h":844},"backdrop":{"x":0,"y":0,"w":390,"h":844}}`, plus viewport-fit=cover + transform:none + fixed checks. Fixes: `viewportFit: cover` in `src/app/layout.tsx`; Backdrop/Popup `inset-0 m-0 [transform:none]`, Popup `overscroll-contain`. `tsc`, `eslint`, 36 unit tests, `git diff --check` clean.
- 2026-09-25: user reported PASS on real phone (geometry + mute flow). Gate satisfied: machine verifier green AND phone PASS.
- 2026-09-25 post-PASS hardening: final re-run exposed verifier flake (Close click intercepted by sticky header `z-40`; takeover had no z-index). Fixed with `z-50` on Backdrop/Popup (matches `ui/dialog.tsx`), verifier now asserts z≥40 + handles connecting→Hang up→Close. Re-ran 3× green, `tsc`/`eslint`/`diff --check` clean.

## Answer

Done. `npm run test:mobile:takeover` is the persistent gate; phone PASS received. Live mute stays manual on future changes.
