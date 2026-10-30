# 12: Spike: synthesis first audio and the cushion

**What to build:** The spike measures the gap from the first sentence request to the first audio frame on a synthesis session opened and acknowledged before the user turn, and reports the configured playout cushion.

**Blocked by:** 09 (Spike fixture and real-time pacer)

**Status:** resolved

- [ ] The synthesis session is opened and its Begin received before the user turn; the handshake is excluded from the term and recorded as a call-start cost instead.
- [ ] The term is the gap from the Generate plus Flush of the first sentence to the first Audio frame.
- [ ] The playout cushion is reported as the configured value with its name, not measured from a live buffer.
- [ ] A term measured from a session opened after the turn is rejected by the report.

## Answer

Ticket 12: `voice-pipeline/spike/first_audio.py` (only new module) + `test_spike_first_audio.py` — `measure_first_audio(opening, turn_at_s, frames, registry)` over recorded frames and `configured_cushion(name="playout.cushion_ms", registry)`, plus `ScriptedSynthesisSession` (injected clock) as the synthetic pre-opened session; 22 tests.
Term: anchored on the first sentence's `Flush` (Generate+Flush; Generate alone would be 167 ms in the scripted case) to the first `Audio` at/after it → **127 ms**, with a 250 ms and a 2000 ms handshake measuring the same 127 ms (open→Begin is recorded separately as `synthesis.handshake_ms`, "call-start cost; excluded"); a session opened at/after the turn, or `Begin` at/after it, raises `SessionOpenedAfterTurn` / `HandshakeInTerm` (the report cannot carry it); no frames → `None` + producer line `spike.run --live (requires ASSEMBLYAI_API_KEY)`, never 0.
Cushion: read only from the threshold registry as `playout.cushion_ms` with the entry's source/date (test fixture source `voni/public/playout-processor.js:63 TARGET_CUSHION_S = 0.5`), unit must be `ms`, and value-without-source is refused by the registry; when the bound is undeclared/open the cushion is reported unmeasured naming the bound (and ticket 04) — no default, no buffer reading.
MERGER NOTE: `thresholds.json` has no `playout.cushion_ms` at df21bedb and ticket 03/04 own that file, so on this branch the cushion reports unmeasured-by-name; adding the bound (value 500, source above, date) turns it into a reported configured value with zero code change. Red proved: guard deleted → 2 errors, anchor at Generate → 5 failures, term measured from open → 4, hardcoded cushion → 3.
Evidence: `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → 272 OK (also via `discover -s voice-pipeline` from repo root); branch `ticket/12-spike-synthesis-first-audio`, commit `9565fac4`, base `df21bedb`, `git merge feat/meta-cascade` → "Already up to date"; no keys/network, `spike/pacer.py`/`fixture.py`/`__init__.py` untouched, tickets 10/11/13 unaffected.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
