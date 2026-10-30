# 151: Nightly drift smoke and the live-run guard

**What to build:** One key-gated call per provider runs nightly, re-records fixtures and alerts on wire drift without committing them. It never writes the production breaker or counter, and no live timing run happens in PR CI.

**Blocked by:** 142 (Provider fixtures run in CI), 34 (Speech fixtures and drift semantics), 45 (Model stream fixtures), 56 (Voice fixtures)

**Status:** resolved

- [ ] One call per leg runs nightly, key-gated and off PR CI.
- [ ] It re-records fixtures and alerts on wire drift without committing them.
- [ ] It does not write the production breaker or counter; it uses a non-production store or records only.
- [ ] A vendor outage is an alert, not a red PR.
- [ ] No live timing run occurs in PR CI, and the existing timing lock still serializes live runs.

## Answer

# 151 — Nightly drift smoke and the live-run guard

**Status: done.** Branch `cluster/e2e-149-151`, commits `6955cbda` (this ticket) and
`f1e866f0` (149), based on integration tip `06f9f097` (`git merge feat/meta-cascade`
→ "Already up to date").

- **Nightly, off PR CI:** new `.github/workflows/nightly.yml` runs on `schedule` +
  `workflow_dispatch` only, `permissions: contents: read`, `environment: nightly`.
  A `keys` job turns secret presence into an output (`secrets` cannot gate a
  job-level `if:`); `live-smoke` is `needs: [keys]` + `if: …present == 'true'`;
  `live-smoke-status` (`if: always()`) asserts success only when keys were
  present and writes `SKIPPED — no keys; no live claim was made` otherwise.
- **One call per leg:** `voice-pipeline/nightly_smoke.py` calls the production
  adapters once each — Meta realtime STT (a tracked synthesized caller line,
  ffmpeg-decoded), Meta Spark chat completions, AssemblyAI synthesis. No keys ⇒
  prints `SKIPPED`, exit 2, and makes no live call
  (`/tmp/opencode/meta-cascade/151-nokeys.log`).
- **Re-records, never commits:** raw inbound frames + adapter observations go to
  `--out` (CI uses `$RUNNER_TEMP/nightly-recordings`), uploaded as a 7-day
  artifact for triage; the module refuses to write under
  `cascade/fixtures/**`, and the workflow has no commit/push step. The recording
  is the fixture's wire content, left unpinned so `expect` stays a reviewed
  decision.
- **Drift is named:** each leg is compared with its committed baseline
  (`stt/events-turn`, `llm/normal-reply`, `tts/begin-echo`) through what the
  adapter observed; a changed known field stops the adapter observing the
  event and is reported by leg + fixture, additive unknown frames are ignored.
  Offline proof: `/tmp/opencode/meta-cascade/151-offline-run.log` (all three
  recordings written, `tts/begin-echo` drift named, exit 1).
- **No production state:** adapters are built without breaker/rungs/store/usage
  sinks ("records only"); a source test forbids importing `cascade.breaker`,
  `cascade.store`, `cascade.usage` and the recorder calls. A vendor failure is a
  nightly alert, not a PR check (the workflow is not referenced by `ci.yml`).
- **Timing lock:** `voice-pipeline/live_lock.py` ports
  `voni/src/lib/demo/timing-lock.ts` (same `/tmp/voni-demo-timing.lock`, JSON
  holder, stale-holder reclaim, 5 s corrupt grace); the workflow deliberately
  takes no override, so a JS demo run and the night cannot overlap.
- **Live guard:** `scripts/e2e-run.mjs` now refuses to start the PR browser E2E
  when any vendor key is in the environment
  (`/tmp/opencode/meta-cascade/151-live-guard.log`), and `ci.yml` carries no
  vendor key or secret at all. The browser spec separately aborts/fails on a
  vendor host.
- **Named blocker, not an invented value:** `META_REASONING_EFFORT` comes from a
  repo/environment variable (M03 owns the number). Unset, the LLM leg reports
  `BLOCKED … ticket M03` and the night exits 3 instead of claiming a live pass.
- **Suites:** `python -m unittest discover -s voice-pipeline -p "test_*.py"` →
  1488 tests OK (1 pre-existing skip), including 26 nightly + 7 lock tests;
  `npm test`/typecheck/lint green on the combined branch.
- **Merger notes:** set the `nightly` environment secrets (`META_API_KEY`,
  `ASSEMBLYAI_API_KEY`) and, when M03 lands, the `META_REASONING_EFFORT` variable;
  until then the night is labelled BLOCKED, never green. Do not add
  `nightly.yml` to branch protection.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
