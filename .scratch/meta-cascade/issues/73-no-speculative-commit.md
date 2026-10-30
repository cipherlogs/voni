# 73: No speculative commit: the negative suite

**What to build:** Three prohibitions are proved, not assumed: the model is never called at speech end, end-of-stream is never sent to force a turn, and a partial is never treated as a final.

**Blocked by:** 67 (Event rules: the final is the only reply trigger), 70 (Floor arbitration while the agent holds the floor)

**Status:** resolved

- [ ] Zero model requests occur between speech end and speech complete for the same turn.
- [ ] End-of-stream is sent only when the call ends; a test asserts it is never sent at speech end.
- [ ] No code path turns a partial into a user message.
- [ ] Removing any one guard makes its test fail.

## Answer

73 done — new `cascade/test_no_speculative_commit.py` is the negative suite over the real seams (`EventRules` + `TimedLLM` recording request times, `TurnStateStore`, `PrefetchSpeculator`, and `MetaStreamingSTT` over `ScriptedSocketFactory`): zero model requests (completion *or* prefetch) in `[speechEnd, speechComplete)`, `END_STREAM_FRAME` absent at speechEnd/speechComplete and present exactly once at call end, a partial only updating turn state (`user_text` is None, `final_text` empty, no request) and the model seeing only the authoritative final text.
Sensitivity is permanent: `SpeculativeAtSpeechEnd(EventRules)` reintroduces a prefetch at speechEnd and the window check must catch it; the guard also fails on a late partial after speechEnd because `offer` rejects `TurnPhase.ENDPOINTED`.
Mutation red-proofs run against this suite: phase guard removed → window test fails; `endStream` sent at speechEnd → 3 failures; `user_text` falling back to the partial → partial test fails; no production code was added by this ticket (the guards are 67/66/30 plus 72's phase guard).
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1127, OK (8 in the suite).
Branch `cluster/orch-71-73`, base cce8b788, commit 250b0477; `git merge feat/meta-cascade` → "Already up to date". `test_naming.py` still passes; no barge-in (88+) and no reconnect work.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
