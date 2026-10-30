# 27: Handshake ack, protocol error and 10 s timeout

**What to build:** The acknowledgement is recognisable, a frame that is not the ack is a protocol error, and a missing ack fails the call visibly.

**Blocked by:** 26 (Meta speech handshake and injected socket seam)

**Status:** resolved

- [ ] A first frame with no type field is the acknowledgement.
- [ ] Any other untyped frame before the acknowledgement is a protocol error that fails the call by name.
- [ ] No acknowledgement within 10 s fails visibly and records the reason.
- [ ] A retryable close at this phase opens the speech leg through the classification table.

## Answer

27 done — `cascade/meta_stt.py` now bounds the ack wait with `asyncio.wait_for` at `HANDSHAKE_BOUND = "stt.handshake_ms"` (registry `require_bound(...)/1000`, default pinned to the spec's 10.0 s); no literal exists, and tests inject only a zero-second bound, never a default.
Ack/protocol: exactly one text JSON object with no `type` is the ack; a typed frame, a JSON array/scalar, or a binary frame before it raises `MetaHandshakeProtocolError` naming `call-123:0`, records `failure_reason`, logs a warning and closes the socket.
Timeout: `MetaHandshakeTimeout` names the bound and records the same reason on the backend (`failure_reason`) plus a WARNING log; a close during the wait is `MetaHandshakeClosed` carrying `classify_stt(code)` — 1011/1013/codeless are `FailureClass.TRIGGER` (`opens_breaker`), 1008 is `BUG` and does not open, so ticket 31/22 can act on `.verdict` without re-deriving it.
Red/green: `cascade/test_meta_stt_ack.py` (10 tests) was red at import before implementation (names absent); `SilentSocket` + zero bound makes the timeout deterministic with no sleep, and `ScriptedSocketFactory([Frame(close_code=...)])` drives each verdict.
Branch `cluster/stt-27-30`, commit `ea762c4a`, base `83ea36ed`; `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → 456 tests OK at this commit. Merger: `MetaHandshakeTimeout`/`MetaHandshakeClosed` (with `.verdict`) and `failure_reason` are the new seam for the close-policy cluster.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
