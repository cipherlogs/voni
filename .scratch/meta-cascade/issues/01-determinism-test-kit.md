# 01: Shared determinism kit

**What to build:** A single test kit every later provider and orchestrator test uses: an injectable clock, scripted STT/LLM/TTS fakes, and a socket/session factory that replays recorded frames. It is the seam that makes the whole cascade testable offline, so no test needs a vendor, a network or a sleep.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] A provider test drives a scripted trace to completion with no network access and no wall-clock wait; a test that sleeps fails review.
- [ ] The injected clock advances only when the test advances it, so every timeout and gap is deterministic across runs.
- [ ] One socket factory serves both a replayed fixture and a fault script (delays, close codes, duplicated frames) without changing the client under test.
- [ ] A deliberately non-advancing clock makes the timeout test fail, proving the kit is wired into the code path rather than wrapped around it.

## Answer

Kit: `voice-pipeline/cascade/testing/{clock,scripted,socket_factory}.py` + `test_kit.py`, API frozen in module docstrings and re-exported from `cascade.testing` — `FakeClock`/`ManualClock`/`FrozenClock`/`RealClock`/`VirtualTimeout`/`run_with_deadline`/`Deadline`, `Step` + `ScriptedSTT`/`ScriptedLLM`/`ScriptedTTS` (real `providers.py` ABC subclasses; record `opened/audio/emitted`, `requests/prefetches`, `spoken`), `Frame`/`ScriptedSocketFactory` and `Response`/`ScriptedSessionFactory`.
Clock: virtual time moves only via test `advance()`/`clock.sleep()`; a deadline is enforced where time moves, so a scripted 30 s delay raises `VirtualTimeout` under `run_with_deadline(timeout_s=5)` with `clock.elapsed == 30.0` and zero wall wait; a scripted delay with no injected clock raises `RuntimeError` by name (sleeping tests cannot be written).
Replay: one `ScriptedSocketFactory` + `Frame` plan serves both the recorded AssemblyAI fixture (Begin/Turn/Termination) and the chaos plan (2500 ms delay, `repeat=2` duplicate, `close_code=1011`) through the unchanged `AssemblyAIStreamingSTT`; `ScriptedSessionFactory` replays SSE/429/body/dropped-connection/delay through unchanged `GatewayLLM` and `CartesiaTTS` with one global post cursor so concurrent sentences stay ordered.
Red proven: `test_kit` first failed `ModuleNotFoundError`; AC4 shown by `/tmp/opencode/meta-cascade/scratch/01-red-ac4.py` — the same "expect `VirtualTimeout`" test passes on `FakeClock` and FAILS on `FrozenClock` ("VirtualTimeout not raised"); the orchestrator tracer test asserts 12 s virtual elapsed, ledger gaps 3000/4000 ms, wall < 2 s.
Tests/commit: `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → 112 tests OK (92 + 20); branch `ticket/01-determinism-test-kit`, commit `9e3c05b9`, base `20751132`, `git merge feat/meta-cascade` → "Already up to date"; merger: only new `voice-pipeline/cascade/` (empty `__init__.py`), later tickets import `cascade.testing` and never edit it, `providers.py`/`backends/` untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
