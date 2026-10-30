# 10: Spike: endpointing and post-processing gap

**What to build:** The spike measures the vendor's endpointing latency and the speechEnd to speechComplete post-processing gap for the same turn, reporting both the wall clock and the vendor's audio-processed cross-check.

**Blocked by:** 09 (Spike fixture and real-time pacer)

**Status:** resolved

- [ ] Endpointing latency is the wall-clock gap between the last speech sample and speechEnd, cross-checked against speechEnd.audioProcessedMs minus the known speech-end position.
- [ ] A disagreement between the two is reported as a disagreement, not averaged into a single number.
- [ ] The post-processing gap is measured for the same turn; a turn without a speechComplete is reported as unmeasured, never zero.
- [ ] Each term carries the producer line that emitted it.

## Answer

Built terms 1-2 in `voice-pipeline/spike/endpointing.py`: per-turnId wall-clock endpointing (pacer `sent_at` of the fixture's last speech sample → `speechEnd.received_at`) cross-checked against `speechEnd.audioProcessedMs − sidecar speech_end_ms`, plus the `speechEnd` → `speechComplete` gap for the same turn.
A synthetic timeline with 700 ms endpointing and 600 ms post-processing injected reproduces both exactly; deletion fails (post value → None: 3 errors, endpointing anchored at stream origin: 5 failures, producer dropped: 1 failure).
A disagreement is reported with both numbers (wall 700 ms vs vendor 1600 ms, delta +900 ms) and keeps the wall term — never the 1150 ms average; a `speechEnd` without `audioProcessedMs` leaves the wall term measured and names the missing cross-check.
No `speechComplete` → the post term is `None` with a producer line naming the missing event (never zero); with no live key or transport both terms are returned unmeasured behind the `META_API_KEY` producer line — no live run executed, so no number is claimed.
Evidence: `voice-pipeline/test_spike_endpointing.py`, 8 tests green; full `voice-pipeline` discovery 258 tests OK, no network/sleeps (injected clock and transport only).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
