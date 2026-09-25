# Mobile takeover fullscreen

Phone fullscreen is broken. The mobile call takeover must occupy the entire visual viewport.

## Scope

- `voni/src/components/voice-call.tsx` mobile Base UI dialog (`landing-demo-mobile-dialog`, `landing-demo-mobile-backdrop`).
- Verifier: `voni/scripts/verify-mobile-takeover.mts` + `npm run test:mobile:takeover`.
- Manual live-mute check stays with the user on a real phone.

## Done gate

Job is done only when `npm run test:mobile:takeover` exits 0 AND the user reports PASS on a real phone. `tsc` / `eslint` / `npm test` alone never close this.
