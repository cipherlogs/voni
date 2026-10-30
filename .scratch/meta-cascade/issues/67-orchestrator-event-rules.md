# 67: Event rules: the final is the only reply trigger

**What to build:** The orchestrator follows the provider's boundary. A start opens a turn, a partial only updates text, an end records the boundary and does nothing else, and only the completion may produce a reply.

**Blocked by:** 66 (Logical turn identity and keyed state), 28 (Event mapping: start, partial, end, complete)

**Status:** resolved

- [ ] A start creates or refreshes the open turn and marks it speaking.
- [ ] A partial updates cumulative text, marks the first partial once, and never becomes a user message.
- [ ] An end records endpointing latency and does nothing else; zero model requests occur before the completion.
- [ ] The completion's text is authoritative even when it differs from the last partial; an empty one is a counted no-speech turn.

## Answer

67 done — `cascade/event_rules.py` adds `EventRules.apply(event)` → `EventOutcome`: `SpeechStart` opens/refreshes the logical turn (`TurnPhase.SPEAKING`), `PartialTranscript` only writes cumulative `partial_text` and marks `first_partial` once per call (ledger), `SpeechEnd` records `speech_end` + `endpointing_ms` and makes no model request, `SpeechComplete` is the only path to the injected `on_reply` seam with `turn.final_text`.
Endpointing producer: `speechEnd` minus the turn's last speech evidence (last transcript update, else `speechStart`), both from the injected clock, rounded to 0.1 ms precision (`round(...,3)`); exposed per turn via `endpointing_ms(turn)` and on the `speechEnd` outcome.
Zero-request rule is pinned by `test_no_model_request_happens_between_speech_end_and_speech_complete` (ScriptedLLM `requests`/`responses_served` stay empty until the completion; deleting the `SpeechEnd` handler turns 3 tests red — verified). Empty/whitespace `SpeechComplete` → `EventKind.NO_SPEECH`, `no_speech_turns` counted, no reply; duplicate completion fires no second reply (`duplicate_finals` guard only — logging/unknown-turn handling left to 68).
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 796, OK (12 new in `cascade/test_event_rules.py`); ruff clean.
Branch `cluster/orchestrator-67`, base `03ad6476`, commit `ad75e908`; `git merge feat/meta-cascade` → "Already up to date". `orchestrator.py` untouched (M06 owns the rebuild/wiring); thresholds untouched, no invented numbers; no `.scratch/` edits.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
