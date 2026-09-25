# 02 — WhatsApp call-screen layout

User report: the transcript filled the whole takeover (looked like fullscreen
was broken) and the layout should feel like WhatsApp/Instagram calls.

## Scope

- `voni/src/components/voice-call.tsx` mobile popup only (desktop card +
  inline mode untouched).
- Verifier: `voni/scripts/verify-mobile-takeover.mts` + `npm run test:mobile:takeover`.
- Static pins: `voni/src/components/voice-call.test.ts`.

## What changed

- Slim header (name + role + status, no buttons) → hero orb with live ring →
  single-line subtitle caption (`landing-demo-mobile-caption`, reserved `h-10`)
  → Captions toggle (history bounded `max-h-[36dvh]`, default collapsed,
  reset per call) → bottom dock (`landing-demo-mobile-dock`).
- Dock: circular Mute (connected-only, `aria-label` Mute/Unmute +
  `aria-pressed`, same hidden-context wiring) + big red circular Hang up
  (`size-16`, `aria-label="Hang up"`); ended shows Call again + Close.
- No speaker/video buttons — no output-device control exists; no fake buttons.
- Verifier adds: orb centered + center stage, caption ≤25% viewport, dock
  bottom-anchored, hang-up ≥56px circle while active, transcript
  hidden-until-toggle and ≤40% viewport when open.

## Status: needs-phone-pass

- 2026-09-25: verifier green 4×, `tsc`/`eslint` clean, 36 unit tests pass,
  `git diff --check` clean.
- Emulation cannot reach connected-with-turns, so the Captions open/close
  flow and connected Mute→Unmute need the phone. Awaiting user PASS.

## Done gate

`npm run test:mobile:takeover` exits 0 AND user reports PASS on a real phone
(geometry + hero/dock feel + captions toggle + mute flow).
