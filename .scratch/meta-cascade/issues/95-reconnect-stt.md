# 95: Speech reconnect replays the turn's audio

**What to build:** A dropped speech socket is recovered by a new session, with the current turn's audio replayed from its start and the new vendor turn mapped onto the existing logical turn.

**Blocked by:** 94 (One reconnect per leg, and planned reconnects are separate), 32 (Speech session lifetime, idle close and deliberate end), 33 (Overlapping turns and a session epoch)

**Status:** resolved

- [ ] A new session with a new handshake is opened.
- [ ] The current logical turn's buffered audio is replayed from its speech start.
- [ ] The new vendor turn id maps to the existing logical turn.
- [ ] Late events from the old session are ignored and the turn's text survives.
- [ ] Killing the socket mid-turn preserves the final text and yields one logical turn.

## Answer

# 95 — Speech reconnect replays the turn's audio

- A dropped socket opens a new session/epoch and re-sends the unanswered audio of every open logical turn in call order (`_reopen(replay=True)` → `_replay_frames`).
- The new session's first `speechStart` binds to the existing logical turn (`TurnStateStore.bind`), so the turn id maps and there is still one logical turn.
- Transcripts join by keeping the fuller text; a replayed final is yielded once (`_yielded_finals`); a late event from the replaced epoch is counted/logged/ignored.
- Every close decision now routes through ticket 94's `ReconnectBudget` (including `immediate=False` for 1013); the adapter's `_retry_used` counter is gone (`retry_used` reads the budget).
- Evidence: `voice-pipeline/cascade/test_stt_reconnect_replay.py` (9 tests), `test_reconnect.py` (+2), fixtures `close-1011`/`close-no-code` now pin the `reconnect` mark.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
