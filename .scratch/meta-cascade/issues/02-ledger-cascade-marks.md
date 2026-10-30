# 02: Ledger: cascade marks and an honest N/A

**What to build:** The timing ledger gains the marks the cascade reports on, and the commit-to-playout row becomes an explicit N/A when no commit mark exists instead of silently falling back to the final transcript mark. The managed path's rows keep their meaning.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Speech end, speech complete, floor take, greeting start/first audio/done, reconnect and cancelled are each recorded once per call, first mark wins, and are readable from the end-of-call ledger.
- [ ] A cascade ledger with no commit mark reports the commit-to-playout row as N/A; a test that reintroduces the final-mark fallback fails.
- [ ] The three cascade gaps (screen latency, think, reply) are each derivable from the marks alone.
- [ ] A mark outside the registry raises by name rather than being silently ignored.
- [ ] Managed ledger output is unchanged by the new marks, pinned by an existing-artifact expectation.

## Answer

02 done — `TimingLedger` now records `speech_end`, `speech_complete`, `floor_take`, `greeting_start`, `greeting_first_audio`, `greeting_done`, `reconnect`, `cancelled` once per call (first write wins) and exposes them in `summary()["marks"]`; the `floor_take_to_first_playout` row is `None` whenever `floor_take` is absent — the `else "final"` fallback is gone.
Files: `voice-pipeline/metrics.py` (MARKS + `CASCADE_GAPS` registry + `cascade_gaps(marks)`; `summary()` N/A row), `voice-pipeline/test_metrics.py` (8 cascade-mark round-trip, N/A, gaps-from-marks-alone, unknown-mark-by-name, managed artifact golden). No orchestrator/providers edits.
Tests: `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 254 tests, OK. Red proved twice: new import failed first; then the N/A test failed (`500.0 is not None`) with the fallback temporarily restored.
Gaps: the three cascade rows (`screen_latency_ms`, `think_ms`, `reply_gap_ms`) come from `cascade_gaps(summary()["marks"])`, so a reader holding only the end-of-call ledger needs no ledger object; a missing anchor is `None`, never 0.
Merger notes: branch `ticket/02-ledger-cascade-marks`, base `df21bedb`, `git merge feat/meta-cascade` → "Already up to date"; managed golden recorded from df21bedb is byte-identical for every managed row and key, with the one intentional delta being the cascade-only floor_take row → `None` (python-map §6.8 accepts this wire change); existing `test_full_turn_reports_all_gaps` was updated to assert N/A.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
