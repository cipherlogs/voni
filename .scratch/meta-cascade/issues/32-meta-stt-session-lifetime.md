# 32: Speech session lifetime, idle close and deliberate end

**What to build:** A long session is bounded by the vendor, not by us: a planned reconnect before the limit, idle input handled as a session end, and a deliberate end that drains and asks the vendor to finish.

**Blocked by:** 26 (Meta speech handshake and injected socket seam), 31 (Speech close-code policy)

**Status:** resolved

- [ ] A call reconnects before 60 minutes at a turn boundary; transcripts are joined in our application, with no resume-token assumption.
- [ ] An idle-input close is handled as a session end, not an audio error.
- [ ] A deliberate end drains queued audio, sends end-of-stream and keeps reading until the vendor closes normally.
- [ ] A dropped socket also ends input, but the deliberate end still uses end-of-stream and the difference is visible in the ledger.

## Answer

32 done — session lifetime reads `stt.session_max_ms` (3,600,000; new literal in `thresholds.json`, source spec "up to 60 minutes") and the injected clock; the planned reconnect margin is the existing bounded handshake (`stt.handshake_ms`), so no second number is invented.
`events()` replaces the session only after a `speechComplete` and only when no turn is still in flight (overlap deferred); the new socket bumps the epoch, keeps the frozen handshake body, carries no resume token, and the application joins `SpeechComplete` rows across sessions (["first","second"], epochs 0/1). Planned and idle reconnects record no failure/trigger/alert, spend no retry, and mark the call ledger `reconnect`.
Idle input is prevented by PCM-silence fill (5 × 20 ms zeros before a caller frame, never a text frame) and, if the vendor still closes, `is_idle_close(reason)` handles it before the code table: a codeless, 1000 or even 1008 close whose reason names idle/no-input is a session end, not an audio bug. Input continues on the replacement session.
Deliberate `close()` drains the lead (endStream at t = 1.0 s under FakeClock), sends `endStream`, reads queued events to the vendor's `1000`; a dropped socket records `DROPPED` with no endStream and the later deliberate end records `DELIBERATE, end_stream_sent=True` on the retried session. `session_ledger` is the speech half of the call ledger (`NORMAL|LIFETIME|IDLE|DROPPED|DELIBERATE|FAILED`, epoch, code, at, planned, end_stream_sent); failures never set `planned` nor the `reconnect` mark.
Evidence: `cascade/test_meta_stt_lifetime.py` 17 tests; red at import, then 6 mutations (hook removed 2F+1E, planned=False 3F, end_stream_sent=False 2F, endStream send removed 2F, idle branch removed 2F+1E, turn-in-flight guard removed 1F). Full suite 929 OK at `082a2bc6`. Branch `cluster/stt-32`, base `8ff36c2a`; `git merge feat/meta-cascade` says already up to date.
Seams for 34: drive `MetaStreamingSTT(call_id, api_key, socket_factory=ScriptedSocketFactory(plans, clock=FakeClock()), clock=, ledger=)` with `Frame(data, delay_ms=…)` plans; `map_event(raw, epoch=…)` is the frame-replay seam; `is_idle_close`, `SessionEndKind`/`session_ledger`, `reconnect_due`, `session_{limit,elapsed,remaining}_s`, `turn_in_flight` are public. Do not add a second clock or a drain timer.
Merger: `thresholds.json` gained `stt.session_max_ms` (data only; no other branch has the key). No local post-endStream drain deadline was added: no STT close-drain bound exists and `deploy.drain_max_wait_ms` is still OPEN (140), so the read is bounded by the vendor's close rather than an invented interval.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
