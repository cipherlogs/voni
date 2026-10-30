# 34: Speech fixtures and drift semantics

**What to build:** Recorded wire frames replay through the injected factory for the handshake, partials, overlap, close codes and reconnect. A fixture is a contract: a changed known field fails by name, an additive event is ignored.

**Blocked by:** 27 (Handshake ack, protocol error and 10 s timeout), 28 (Event mapping: start, partial, end, complete), 29 (Speech audio path, pacing and malformed frames), 31 (Speech close-code policy), 32 (Speech session lifetime, idle close and deliberate end), 33 (Overlapping turns and a session epoch)

**Status:** resolved

- [ ] Recorded frames replay for handshake, partials, overlap, close codes and reconnect.
- [ ] A fixture with a changed known field fails and names the drift.
- [ ] A fixture with a new additive event passes and the event is ignored.
- [ ] The suite runs in the Python CI job with no vendor key.

## Answer

# 34 — STT recorded fixtures and drift semantics

1. Added `cascade/stt_replay.py`: a closed-schema fixture loader/replayer over the production `MetaStreamingSTT`, ticket-01 scripted socket factory and `FakeClock`; it pins the client handshake, mapped events, turn state, audio-path drops, close decisions, session endings, reconnect marks and epochs.
2. Added 16 fixtures under `cascade/fixtures/stt/`: handshake ack + protocol error; turn lifecycle + unknown/additive ignored; malformed binary + 5 s lead pacing; close 1000/1008/1011/1013/no-code; planned lifetime reconnect, idle close, deliberate end; overlapping turns and epoch reuse.
3. Drift: a changed known frame or pin fails naming the fixture and field; an additive unknown event passes and is ignored; a missing/malformed/unreplayable fixture raises `FixtureError`, never skips; every on-disk recording is guarded as exercised.
4. Offline: explicit test key, no env read, no socket, no sleep; 28 tests in `cascade.test_meta_stt_fixtures`, full discovery 1112 OK.
5. Branch `cluster/stt-34`, commit `2a5ade0` on base `cce8b788` (integration tip unchanged; no merge needed). Adapter untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
