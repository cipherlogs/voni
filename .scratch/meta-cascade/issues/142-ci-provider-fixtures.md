# 142: Provider fixtures run in CI

**What to build:** One fixture suite per provider runs in the Python CI job. A changed known field fails by name, an additive event passes, and no suite needs a vendor key.

**Blocked by:** 08 (Python CI job with a proved red case), 34 (Speech fixtures and drift semantics), 45 (Model stream fixtures), 56 (Voice fixtures)

**Status:** resolved

- [ ] One suite per provider runs in the Python CI job.
- [ ] A changed known field fails the job and names the drift.
- [ ] An additive unknown event passes.
- [ ] The suites need no vendor key.
- [ ] A deliberately stale fixture fails the job, and the red run is attached.

## Answer

# 142 — Provider fixtures run in CI

**Status: done.** Branch `cluster/ci-142` @ `9d5c34f2`, based on integration tip
`098fdf9d` (`git merge feat/meta-cascade` → "Already up to date").

- **Built:** `.github/workflows/ci.yml` adds a named `Provider fixture suites
  (STT, LLM, TTS)` step inside the existing `python` job (working-directory
  `voice-pipeline`, command runs `cascade.test_meta_stt_fixtures`,
  `cascade.test_meta_llm_fixtures`, `cascade.test_tts_fixtures`,
  `test_fixture_manifest`). New `voice-pipeline/test_fixture_manifest.py`
  (12 tests) re-runs each provider suite with a recorder: every JSON fixture on
  disk (16 STT + 6 LLM + 16 TTS) must be replayed *successfully*, under an empty
  environment; a fixture that is listed but never replayed, or on disk but not
  listed, fails by name. It also proves one changed known frame per provider
  fails by fixture name, and asserts `python_job` still names all three suites
  and has no `paths:` filter, no step `if:`, no `continue-on-error`, no vendor
  key, and that `required-python` (`needs: [python]`, `if: always()`, asserts
  `needs.python.result == 'success'`) still turns skip/cancel/failure into a
  failed check. `requirements-ci.txt` unchanged: stdlib `unittest` only.
- **Green, exact CI commands** (fresh `uv venv --python 3.13 .venv` +
  `uv pip install -r requirements-ci.txt`): judge import OK;
  `PUBLIC_HOST=ci.invalid .venv/bin/python -m unittest discover -s telephony-bot
  -p "test_*.py"` → **Ran 74, OK**; `... discover -s voice-pipeline -p
  "test_*.py"` → **Ran 1312, OK (skipped=1, pre-existing tools test)**; fixture
  step → **Ran 84, OK** (28 STT + 14 LLM + 30 TTS + 12 manifest).
- **TDD red first:** before the workflow edit the manifest failed exactly 4
  wiring tests (`'cascade.test_meta_stt_fixtures' not found`, same for LLM/TTS,
  and the missing fixture step); after the step landed the same file is green.
- **Red evidence 1 (stale/broken fixture):** changed the `speechComplete`
  frame text in `cascade/fixtures/stt/events-turn.json` (`"How are you?"` →
  `"How are you"`), ran the exact fixture step: exit 1,
  `FAIL ... EventFixtureTests ... AssertionError: fixture 'events-turn'
  drifted at events, turns: ...`. Full log:
  `/tmp/opencode/meta-cascade/142-red-stale-fixture.log`. Fixture restored.
- **Red evidence 2 (not exercised):** copied `events-turn.json` to
  `fixtures/stt/zz-unexercised.json`; `test_fixture_manifest` exits 1,
  `Items in the first set but not the second` for provider `stt`. Log:
  `/tmp/opencode/meta-cascade/142-red-unexercised-fixture.log`. File removed.
- **Merger notes:** no Actions run URL — the branch was never pushed, so branch
  + SHA + local logs are the evidence (same convention as 08). Branch
  protection must require `required-python`; that half is a repo setting, not
  code. The fixture step is inside `python`, so the existing `required-python`
  gate covers it; skipping/cancelling `python` fails the gate. No dependencies
  added and no fixture content changed.
- **Reproduce:** `cd <worktree> && uv venv --python 3.13 .venv && uv pip install
  --python .venv/bin/python -r requirements-ci.txt`; then the three commands
  above; fixture step from `voice-pipeline/`:
  `../.venv/bin/python -m unittest cascade.test_meta_stt_fixtures
  cascade.test_meta_llm_fixtures cascade.test_tts_fixtures test_fixture_manifest`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
