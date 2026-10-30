# 77: The greeting is spoken before any user audio

**What to build:** The body's greeting is synthesized through the bound voice before the visitor speaks, so the call is never silent and the reference line describes audio the call actually says.

**Blocked by:** 75 (Call lifecycle and the end message), 48 (Begin echo is an assertion), 02 (Ledger: cascade marks and an honest N/A)

**Status:** resolved

- [ ] The body's greeting is spoken before any user frame, through the bound voice.
- [ ] Greeting start, first audio and done are recorded in the ledger.
- [ ] The greeting is not a turn and is excluded from reply-gap samples.
- [ ] A call with no user audio still speaks the greeting and ends with a drain.
- [ ] A body with no greeting opens silently, recorded as intentional.

## Answer

77 done — new `cascade/greeting.py` speaks `body.greeting` through the opened voice's `speak_greeting` (one Generate+Flush, first sentence immediate), forwards every frame to the call's audio sink, and records `greeting_start` / `greeting_first_audio` / `greeting_done` in the ledger. It writes no `first_playout`/`speech_complete`, so the greeting is not a turn and cannot enter a reply-gap sample; a call with no user audio still greets and drains.
`CallLifecycle` now greets after speech/voice/model open and before `CallStream.start()` and the audio pump, so no caller frame can be processed first. An absent/empty greeting opens silently and is recorded as intentional on the end message (`greeting.spoken=false`); a greeting failure, a silent synthesis, a voice-binding mismatch, a session without `speak_greeting`, or a missing audio sink ends the call visibly with `stage="greeting"` before the stream starts.
Tests: `cd voice-pipeline && /home/cipherlogs/Repos/AI/leadcalls/telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 1119, OK (15 new for 77: 9 in `cascade/test_greeting.py`, 6 in `cascade/test_call.py`). `cascade/test_greeting.py` opens a real `AssemblyAIStreamingTTS` over the recorded fixtures to prove Generate+Flush, rather than trusting the fake.
Branch `cluster/call-76-98`, base `cce8b788`, commit `4d630072`. Merger notes: `CallEnd` gains `greeting` (additive wire field); `CallLifecycle` gains `send_audio`; ticket 78 owns chime timing on the first frame, 79 owns barge-in Cancel, 80 owns breaker/text pinning.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
