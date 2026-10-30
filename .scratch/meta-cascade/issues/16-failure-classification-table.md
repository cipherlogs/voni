# 16: Failure classification: trigger, bug or planned reconnect

**What to build:** One pure table decides what a provider failure means. Retryable failures open the leg; deterministic request errors fail the call and alert without hiding behind a fallback; session expiry and planned reconnects are neither.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Retryable triggers open the leg: speech close 1011 or 1013; model 429, 5xx or timeout; voice timeout, an abnormal socket close (no code, 1006, 1011) or 3005 after its one retry.
- [ ] Deterministic request errors fail the call and alert without opening: speech 1008; voice 3006, 3010, 3011, 1009; model 400.
- [ ] Session expiry (3008) and the 60-minute speech limit classify as planned reconnect, never as a trigger.
- [ ] An unknown code is classified by name and fails closed to do-not-open; it never defaults to retryable.
- [ ] A test asserts every code in the edge-case catalog is classified exactly once.

## Answer

Built `voice-pipeline/cascade/failures.py`: `FailureClass{trigger,bug,planned_reconnect,do_not_open}`, `FailureVerdict.opens_breaker`, one read-only rule table per leg (`STT_CLOSE_RULES`, `LLM_STATUS_RULES`, `TTS_CLOSE_RULES`) plus `classify_stt/llm/tts/code` dispatchers; `SESSION_LIMIT`, `LLM_SERVER_ERROR` ("5xx"), `LLM_TIMEOUT` sentinels carry no invented numbers.
Verdicts: stt 1011/1013/None=trigger, 1008=bug, 1000=do_not_open, SESSION_LIMIT=planned; tts 3005/1006/1011/None=trigger, 3006/3010/3011/1009=bug, 3008+expires_at=planned, 1000=do_not_open; llm 429/5xx/timeout=trigger, 400=bug; every unlisted code (incl. another leg's code) = do_not_open naming leg+code.
Test: `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` -> Ran 121 tests, OK (29 new; red-first proven, two mutations killed 12 and 2 tests).
Catalog test asserts each of the 19 catalog/spec rows gets its documented class and each code appears once per leg; `test_each_leg_table_names_exactly_the_spec_codes` pins the tables to exactly the spec-named codes.
Branch `ticket/16-failure-classification-table`, base `20751132`, merge with feat/meta-cascade: "Already up to date." Downstream 17-23/31/55/106 import `classify(leg, code, timed_out=...)`; retry counts and breaker writes stay out of this module.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
