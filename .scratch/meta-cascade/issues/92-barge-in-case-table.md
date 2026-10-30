# 92: The recorded barge-in case table passes unchanged

**What to build:** The cross-engine recovery table is the proof. It passes on the cascade exactly as it passes on the managed path: double barge-in, expiry, greeting, goodbye and tool-hold.

**Blocked by:** 88 (Barge-in cuts with Cancel, not a socket close), 52 (Cancel semantics and the next flush id), 89 (The unheard tail is located from the played position)

**Status:** resolved

- [ ] The recorded recovery case table passes unchanged on the cascade.
- [ ] Double barge-in keeps one acknowledgement per cancel and the latest caller turn wins.
- [ ] A cancel after expiry gets no acknowledgement; playback stops locally.
- [ ] Greeting, goodbye and tool-hold barge-ins each cancel the right producer and preserve the caller's turn.
- [ ] A difference from the managed table is a bug, not a new expected value.

## Answer

92 done — the cross-engine table is `cascade/fixtures/barge_in/cases.json` (recorded values + sources). Recovery half: the managed table `voni/src/lib/voice/barge-in-recovery.cases.json` is read directly (not copied) and every recorded row is replayed on the cascade's real locating + resume seams; the fixture records its row names, so a missing managed row is `MissingBargeInCase` by name and an unrecorded new one is `UnrecordedBargeInCase`. Lifecycle half: double barge-in (2 Cuts, 2 `Cancelled` acknowledgements, stale resume cancelled, flush 6 wins), cancel-after-expiry (1 Cancel, 0 acknowledgements, client flushed, 0 frames after, locally stopped), greeting (1 greeting line, greeting cancelled, 0 frames after, caller turn speaks), goodbye (cause `goodbye`, closing producer cancelled, 0 stale frames, caller turn speaks), tool-hold (hold cancelled once from its first frame, 0 frames after, tool result still `["user","assistant","tool"]`, caller turn speaks). Every row runs; unknown kind → `UnhandledBargeInCase` by name, missing/duplicate row and empty `expect` fail by name, a mismatch names row+key+both values ("not a new expected value").
Tests: `cd voice-pipeline && …/python -m unittest cascade.test_barge_in_case_table` → 11 pass; full suite Ran 1477, OK (skipped=1). Red-proofs: dropping `_cancel_resume` in `cut` fails the double row (`cancelled_resumes` 1→0); a one-word-loss mutation in the adapter's `_tail_from` fails 5 managed rows with `'booking and reminders for you' != 'and reminders for you'` etc.
Files: `voice-pipeline/cascade/{fixtures/barge_in/cases.json,test_barge_in_case_table.py}`; commit `34a076de`; branch `cluster/barge-90-92`; base `06f9f097`; `git merge feat/meta-cascade` → Already up to date.
Merger: the recovery half needs `voni/src/lib/voice/barge-in-recovery.cases.json` present at repo root (same path the phone test reads); `recorded_cases`/`recovery_rows`/`run_case` are the runner seam if a later ticket adds a row. Goodbye is driven through the cut path with cause `goodbye`; hangup-disarm itself stays ticket 87's.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
