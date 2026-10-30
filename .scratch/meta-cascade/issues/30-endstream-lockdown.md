# 30: Only end-of-stream may be sent after the handshake

**What to build:** The client can end the call's input but cannot force a turn. End-of-stream is the only text frame after the handshake, and a negative test proves no other is ever emitted, including on reconnect.

**Blocked by:** 26 (Meta speech handshake and injected socket seam)

**Status:** resolved

- [ ] The only client text frame after the handshake is end-of-stream.
- [ ] No force-endpoint, configuration update or per-turn commit exists; attempting one fails to compile or import by name.
- [ ] The negative test replays a full call including a reconnect and asserts exactly one text frame per session, failing on any other.
- [ ] End-of-stream is sent only at call end or drain, never at speech end.

## Answer

30 done — after the handshake the only client text frame is `END_STREAM_FRAME = {"type":"endStream"}`; there is no `force_endpoint`, `update_configuration`, `end_turn`, `take_floor`, `end_stream` method, and `ForceEndpoint`/`UpdateConfiguration`/`FORCE_ENDPOINT` cannot be imported by name.
Negative test: two full sessions (open → events → audio → close → reconnect → repeat) assert each socket's text frames are exactly the handshake plus one `endStream`, every other frame is even-length binary, and no other JSON `type` ever appears.
Deliberate end: `close()` drains the audio lead first (bounded by `MAX_LEAD_S`, virtual under `FakeClock`: endStream is sent at t≈1.0 after 1 s of audio), sends `endStream` once, then keeps reading until the vendor closes; `last_close_code` records `1000` (normal) or `None` when the socket just ends. `close()` is idempotent and a close before the ack sends nothing.
`events()` ends cleanly on a 1000 close and re-raises every other close untouched — code policy (1008/1011/1013) is deliberately left to ticket 31.
Red/green: `cascade/test_meta_stt_endstream.py` (11 tests) red at import pre-implementation; suite 496 OK at `ebe98960`. Merger: `_await_vendor_close` currently has no local drain deadline — ticket 32 owns that bound and the dropped-vs-deliberate distinction; 31 owns the non-1000 policy.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
