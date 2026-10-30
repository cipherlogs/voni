# 149: A real browser seam writes a delivered capture on every PR

**What to build:** A real Chromium runs the real browser client, the real playout worklet and a deterministic fake WebSocket server replaying recorded frames. It writes a real delivered capture on every PR, so a client regression is caught before a live call.

**Blocked by:** 121 (W0 delivered capture is sample-exact and non-intrusive), 142 (Provider fixtures run in CI), 75 (Call lifecycle and the end message)

**Status:** resolved

- [ ] A real Chromium runs the real browser client, the real playout worklet and a deterministic fake WebSocket server.
- [ ] It writes a real delivered capture on every PR without a live vendor.
- [ ] It is not a live vendor run; its artifact is a browser-delivery artifact, not a cutover artifact.
- [ ] A deliberate client regression fails it.
- [ ] Runtime stays inside the recorded budget, or it moves to a required pre-merge job, never nightly-only.

## Answer

# 149 — A real browser seam writes a delivered capture on every PR

**Status: done.** Branch `cluster/e2e-149-151`, commits `f1e866f0` (this ticket) and
`6955cbda` (151), based on integration tip `06f9f097` (`git merge feat/meta-cascade`
→ "Already up to date").

- **Built:** `npm run test:e2e:cascade` (`scripts/e2e-run.mjs cascade`) builds an
  isolated production-mode candidate, serves it, and drives the real
  `/e2e/cascade` page in desktop Chromium: real `VoiceCall` + `CascadeSession`,
  real mic path, real `playout-processor` worklet. The service half is
  Playwright WebSocket routing replaying the committed
  `voni/tests/e2e/fixtures/cascade-call.json` (two captions, 1.2 s of stamped
  24 kHz PCM, `end_call`); the spec aborts and names any vendor host request.
- **Capture:** the worklet tap's WAV (`DeliveredCapture`) is saved by the harness
  as `voni/test-results/cascade-e2e/browser-delivered.wav` plus a
  `browser-delivery.json` sidecar (`kind: browser-delivery`, `pipeline: cascade`,
  `legs: ["delivered"]`, sha256). The spec fails if no capture POST arrives, if
  the WAV is malformed/short/silent, or if the client leaks a prompt/tool
  list/pipeline in its token-only config (65's contract).
- **CI:** new `browser-e2e` job in `ci.yml` on every PR (no path filter, no job
  `if:`, no soft-fail) plus `required-browser-e2e` (`needs` + `if: always()` +
  asserts success); the capture is uploaded on green and red with
  `if-no-files-found: error`.
- **Budget:** `scripts/browser-e2e-budget.mjs` reads `ci.browser_e2e_budget_s`
  from `voice-pipeline/cascade/thresholds.json`. The bound is still **OPEN**, so
  the run prints `UNMEASURED — bound … ticket 149 must supply a value … no
  default is substituted` and makes no runtime claim (measured run: 151.4 s).
  A recorded value is enforced; over budget fails with "move to a required
  pre-merge job, never nightly-only". The job's `timeout-minutes` is a hang
  guard only and is asserted not to restate the budget.
- **Red proofs:** missing harness page → `/tmp/opencode/meta-cascade/149-red-e2e.log`;
  deliberate client regression (deleted `cascade.setDeliveredCapture(...)`) →
  `/tmp/opencode/meta-cascade/149-regression-red.log` ("the delivered capture was
  written" times out). Reverted after the run.
- **Green:** `/tmp/opencode/meta-cascade/149-green-e2e-4.log` — 1 passed (6.6 s);
  capture 74,284 bytes, 37,120 samples, 24 kHz, 1.547 s, sha256
  `25b195f285bfb4fe7a25e0e78d0357a3b5ce80dde3c69285086696396c285364`.
- **Suites:** `npm test` 2163 tests (2162 pass, 1 pre-existing skip);
  `npm run typecheck` clean; `npm run lint` 0 errors (2 pre-existing warnings).
  Reproduce: `cd voni && npx playwright install --with-deps chromium &&
  node scripts/e2e-run.mjs cascade` (TTL 6 s spec, ~2.5 min candidate build).
- **Merger notes:** branch protection must require `required-browser-e2e`.
  `/e2e/*` is excluded from the copilot manifest (`generate-app-manifest.mts`).
  The capture sink is the spec's route; the app's dev route still 404s in
  production, and the build-time opt-in (`NEXT_PUBLIC_VONI_E2E_CAPTURE`) is set
  only on the throwaway e2e candidate. `all` mode deliberately excludes cascade.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
