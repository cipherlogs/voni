# 33: Overlapping turns and a session epoch

**What to build:** Turns can overlap: a later start may arrive before an earlier completion. Both are tracked, a partial is never attributed to the wrong turn, and every event carries a session epoch the orchestrator can key on.

**Blocked by:** 28 (Event mapping: start, partial, end, complete)

**Status:** resolved

- [ ] A start before an earlier completion keeps both turns distinct.
- [ ] A partial with no preceding start is not attributed to any turn.
- [ ] The backend stamps a session epoch on every event so a reused vendor turn id can be disambiguated.
- [ ] A late event from an old session after reconnect is marked and ignored.

## Answer

33 done — every yielded event carries `session_epoch`; `SpeechStart`/`SpeechEnd`/`SpeechComplete` gained it additively, and `SpeechPartial(PartialTranscript)` carries only `text` + `session_epoch` (no `turnId`).
Turn state is one `cascade.turn_state.TurnState` per `(epoch, provider turnId)` via `TurnStateStore`; `open()` is the only thing that moves the epoch (adapter owns it, store follows in lockstep from `start_epoch=-1`). A later `speechStart` before an earlier `speechComplete` keeps both turns distinct; a partial lands on the most recent start; `speechComplete` text wins over the last partial.
Unknown/duplicate completions and unknown/closed `speechEnd` are logged and dropped; a partial with no start creates no turn. A late event from a replaced session is counted in `stale_events`, logged with both epochs, and ignored by `map_event(raw, epoch=…)`, so a reused vendor `turnId` after reconnect is a different `LogicalTurnId` (`(0,turn-1)` vs `(1,turn-1)`).
Evidence: `cascade/test_meta_stt_overlap_epoch.py` 14 tests (red at import, mutations 8F+3E); `test_meta_stt_events.py` field pins updated; full suite 811 OK at `f1588ae3`. Merger: `SpeechPartial` is still a `PartialTranscript` for `orchestrator.py`; consumers that compared an exact `PartialTranscript` class must accept the subclass; `map_event` is the deterministic replay seam for 34 fixtures.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
