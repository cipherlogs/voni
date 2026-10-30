# 93: The agent's own voice is never a command

**What to build:** The existing echo and overheard classifier suppresses the agent's own voice. Played-back speech does not become an interruption, a command or a reply.

**Blocked by:** 70 (Floor arbitration while the agent holds the floor), 88 (Barge-in cuts with Cancel, not a socket close)

**Status:** resolved

- [ ] The existing classifier suppresses the agent's own voice.
- [ ] The agent's own speech never becomes a command or an interruption.
- [ ] The classifier is shared, not reimplemented; a second copy fails review.
- [ ] A test feeds the agent's own line back and asserts no reply and no cancellation.

## Answer

93 done — the agent's own voice now never takes the floor. `FloorArbiter.arbitrate(text, barge_probability=…, agent_text=…)` checks the one shared `floor.is_echo` before the command/filler sets and returns `wait` on an echo: the agent keeps speaking, the cut path is never asked to cancel, and no reply is started. Finals were already suppressed by `FinalGate` (ticket 71): counted `overheard`, no reply, `cancel=False`; the new end-to-end test feeds the agent's whole line back as both a partial and a final and asserts no `Cancel`, no reply, no model request, one `overheard` count.
No second classifier: `is_echo`/`ECHO_SHARE` are untouched and reused; tests assert the share still matches `voni/src/lib/voice/barge-in.ts`, that `def is_echo` exists only in `floor.py`, and that the gate and arbiter both call the injected classifier. The control (same words over a different agent line, or no agent line) still takes the floor, so suppression fails closed on evidence.
Tests: `cd voice-pipeline && …/python -m unittest cascade.test_echo_suppression` → 10 pass; full suite Ran 1329, OK (skipped=1). Red-proof: removing the arbiter's echo branch fails 4 tests. No reply/`Cancel` change to `event_rules.py` or `barge_in.py`.
Files: `voice-pipeline/cascade/{floor.py,test_echo_suppression.py}`; commit `51877b2a`; branch `cluster/barge-89-93`; base `098fdf9d`; `git merge feat/meta-cascade` → Already up to date.
Merger: M06's orchestrator must pass the agent's current line as `agent_text` to `arbitrate`; without it the echo guard fails closed and an echoed command could cut again. `FloorArbiter` gained only `is_echo_fn` (default `is_echo`) and the `agent_text` keyword.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
