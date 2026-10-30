# 08: Python CI job with a proved red case

**What to build:** A CI job installs the bridge venv the judge parity imports, the service's vendor libraries and the web framework, then runs the Python suite. The repo runs no Python job today, so a broken pipeline test is invisible.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] The job runs the existing Python suite and fails on a failing test.
- [ ] A deliberately red commit (one broken assertion) is shown failing the job, and the run is attached to the ticket.
- [ ] The job passes without a vendor key or network access.
- [ ] The job is required, not advisory: a skipped or cancelled Python job does not report success.

## Answer

# 08 — Python CI job with a proved red case

**Status: done.** Branch `ticket/08-python-ci-job` @ `ed2d88de`, based on
`feat/meta-cascade` @ `20751132` (`git merge feat/meta-cascade` → "Already up to date").

- **Built:** `.github/workflows/ci.yml` (+56 lines) — job `python` (checkout →
  `setup-uv@v6` → `uv venv --python 3.13` + `uv pip install -r requirements-ci.txt`
  → judge import → Bridge suite → Pipeline suite) and gate job `required-python`;
  root `requirements-ci.txt` pins the 7 deps the two suites need.
- **Green, locally, exactly as CI runs it:** judge import OK (`aiohttp 3.14.3`,
  `heuristic_barge_in_score("stop", 3000) == 0.9`); `PUBLIC_HOST=ci.invalid
  .venv/bin/python -m unittest discover -s telephony-bot -p "test_*.py"` → **Ran 74
  tests, OK**; same for `-s voice-pipeline` → **Ran 92 tests, OK** (166 total). No
  vendor key in the env and no network in the tests.
- **Red case 1 (ticket AC2, broken assertion):** throwaway branch
  `ticket/08-python-ci-red` @ `bb67f5bd` (child of `ed2d88de`) flips
  `telephony-bot/test_voice_judge.py::BargeInTests.test_backchannel_never_yields`
  to expect `yield`. The verbatim *Bridge suite* step exits **1**:
  `AssertionError: 'keep-speaking' != 'yield' : uh-huh` / `FAILED (failures=1)`
  (log: `/tmp/opencode/meta-cascade/mc-ci-red.log`). No Actions run URL exists:
  this workflow has never run on GitHub from this machine, so branch + commit sha
  are the evidence; the red branch is left local and reachable for `git show`.
- **Red case 2 (the trap):** in the same venv with `aiohttp` uninstalled, the
  *Judge import* step fails `ModuleNotFoundError: No module named 'aiohttp'`. This
  is the assertion that matters: `voice-pipeline/orchestrator.py:_default_scorer`
  wraps that import in `except Exception: return 0.0`, so without an explicit check
  the job could be green with a permanently degraded judge. Restored + re-ran green.
- **AC4 (required, not advisory):** no `paths:` filter and no job-level `if:`;
  `timeout-minutes: 10` turns a hang into a failure; `required-python`
  (`needs: [python]`, `if: always()`, asserts `needs.python.result == 'success'`)
  fails on `skipped`, `cancelled` and `failure`. **Merger/owner action:** branch
  protection must require `required-python` — that half is a repo setting, not code.

**Reproduce:**

```bash
cd <worktree>
uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r requirements-ci.txt
PUBLIC_HOST=ci.invalid .venv/bin/python - <<'PY'
import sys; sys.path.insert(0, "telephony-bot")
import aiohttp, voice_judge
assert voice_judge.heuristic_barge_in_score("stop", 3000) == 0.9
PY
PUBLIC_HOST=ci.invalid .venv/bin/python -m unittest discover -s telephony-bot -p "test_*.py"
.venv/bin/python -m unittest discover -s voice-pipeline -p "test_*.py"
```

Local note: `/tmp` is a full 7.5 G tmpfs, so the proof venv lives at
`/home/cipherlogs/.cache/mc-ci-08/.venv` and was symlinked to `<worktree>/.venv`
(now removed); the commands above are byte-identical to the workflow steps.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
