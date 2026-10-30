# 88: Barge-in cuts with Cancel, not a socket close

**What to build:** An interruption is a caller winning the floor. The server cancels synthesis, stops the producer, tells the client to flush, and drops audio that belonged to the cancelled request.

**Blocked by:** 75 (Call lifecycle and the end message), 52 (Cancel semantics and the next flush id), 02 (Ledger: cascade marks and an honest N/A)

**Status:** resolved

- [ ] On a taking-the-floor decision, synthesis is cancelled, the producer stops, the client flushes, and frames between cancel and acknowledgement are dropped.
- [ ] Audio stops within the cut budget of the caller's speech start.
- [ ] The interruption is recorded as a real cut, not a soft yield.
- [ ] A test that closes the socket instead of cancelling fails.

## Answer

88 done — new `cascade/barge_in.py`: `BargeInCutPath` produces one reply's `SentenceAudio` and cuts it with TTS `Cancel` (`await tts.cancel()`), never `close()`. Order: bump the reply generation synchronously (a pulled frame is never played after this line), send `Cancel`, cancel/await the producer task, then emit `PlayoutFlush(generation, flush_id, cause, at)` to the client; the synthesis socket survives and the next reply starts on the new generation with whatever `flush_id` the vendor assigns (read from the wire, may skip). No soft yield: the cut returns while the stale sentence is unfinished.
Records: `cancelled` ledger mark once per call (first write wins), `interruption` count once per cut, `BargeInCut.stop_latency_ms` vs record-backed `barge_in.real_cut_ms` (`within_budget: None` when no speech start), `dropped_frames`, and `BargeInCut.seam` (`CutSeam(played_ms, flush_id, generation, turn, reply)`) for 89. `played_ms` is stored verbatim, `None` when unreported; tail location (89), resume (90), filler (91), case table (92), echo (93) untouched.
Seam for wiring: `BargeInCutPath(tts=..., on_audio=..., flush_playout=..., clock=..., ledger=...)`; `start(audio, flush_id=None, turn=..., reply="")`, `await cut(cause, speech_started_at=..., played_ms=...)`, `await join()`, `await stop()` (drain). `flush_playout` is where the transport maps the flush to its wire shape/`seq`.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1098, OK (14 new in `cascade/test_barge_in.py`; real `AssemblyAIStreamingTTS` over a pushable scripted socket + recording fakes, `FakeClock`, no sleeps). Negative controls run: close-instead-of-cancel fails 6 tests, no-generation-bump fails the Cancel→Cancelled drop test, no-producer-stop fails the no-soft-yield test.
Branch `cluster/barge-88`, base `cce8b788`, commit `3b8fafcd`; `git merge feat/meta-cascade` reported "Already up to date". Merger note: `call.py` not touched — no integration required; ticket 76/74's reply loop wires `start`/`cut` and owns the client `seq`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
