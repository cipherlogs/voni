# 54: Termination and the billed character count

**What to build:** A deliberate end returns the final flush and a termination record; the billed character count is recorded as the unit the vendor meters.

**Blocked by:** 47 (Synthesis connect per transport)

**Status:** resolved

- [ ] Terminate returns the final flush confirmation and then a termination record.
- [ ] The termination's billed character count is recorded per call.
- [ ] Audio and session durations are recorded as facts.
- [ ] A call that ends without a termination records its characters as unmeasured, never zero.

## Answer

54 done — `terminate()` sends `Terminate` and no extra `Flush` (the vendor's implicit flush), drains the final `FlushDone` and then `Termination`, keeps any audio still owed as `TerminationRecord.residual_audio`, and returns a record holding `flush_done`/`final_flush`, the summary and the billing.
Billing: `Billing.characters` is `billed_characters` when present, else `total_input_char_length` (the `source` names which); both are kept apart, and `audio_duration_seconds`/`session_duration_seconds`/`audio_bytes` are recorded as facts.
Unknown is not zero: `close()` without a `Terminate` (or a summary that never arrives) leaves `characters=None`, `measured=False`, `source` naming "unterminated"; `close()` after `terminate()` keeps the measured record.
Tests: 10 new in `cascade/test_tts_termination.py`; red first (no `terminate`/`close`), and forcing `0` for an absent count or dropping residual audio fails two of them. Full suite 501 OK.
Files: `voice-pipeline/cascade/{assemblyai_tts.py,test_tts_termination.py}`; commit `12ddf23a`.
Merger notes: `terminate()` closes the socket, so a later `cancel()`/`terminate()` refuses with "session is not open"; `tts.termination` keeps the raw summary for the end-message/ledger work (M06/M17).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
