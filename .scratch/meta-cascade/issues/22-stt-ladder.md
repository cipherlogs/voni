# 22: Speech ladder: Meta, AssemblyAI, then fail

**What to build:** The record selects the speech rung. An open Meta leg means a new call makes zero speech requests to Meta and uses AssemblyAI; a failure on speech never touches the model rung.

**Blocked by:** 15 (Breaker record and durable shared store), 17 (Breaker transitions on a fake clock)

**Status:** resolved

- [ ] The record decides the rung; no per-call heuristic or in-process cache can override it.
- [ ] With the speech leg open, a new call makes zero requests to Meta and uses AssemblyAI.
- [ ] A speech failure never changes the model rung.
- [ ] The rung actually used is recorded for turn attribution.
- [ ] Removing the rung selection makes a call attempt the open provider and the test fails.

## Answer

22 done — `cascade/ladders.py` gains `STT_LADDER` (meta → assemblyai), `LegFailed`, `ProviderAttribution`, `SpeechSession` and `open_speech()`; `cascade/test_stt_ladder.py` is new (9 tests).
Selection: one durable `read_choices` per call, one factory call for the rung the record selected. With the stt record `open`, the Meta factory is never called (zero Meta sessions/requests) and AssemblyAI is used; with it `closed`, Meta is used; flip the record between calls and the next call follows it (no cache). The attribution (`leg, provider, rung, reason`, `to_document()`) names the provider actually built, for turn attribution (ticket 108).
Fail visibly: a chosen rung with no registered factory, or a factory that raises, becomes `LegFailed("stt", reason)` naming the provider — the other rung is never tried (no mid-call handover), so Meta cannot be reached after AssemblyAI was selected. An unreadable record raises `LegUnreadable` before any factory call.
Decoupling: a speech failure through `CallRungs` leaves the llm record at version 1, `closed`, and the next speech choice fallback while the model choice stays primary.
Judgments: the factory returns an unopened `StreamingSTT` (the `open(language_codes, sample_rate)` call belongs to the caller, which owns the body's language bundle); `open_speech` never opens a socket itself, so the test's "zero requests" is exact. `MetaStreamingSTT` cannot yet send audio/events (tickets 28/29), which is why the ladder seams on the ABC + factory rather than on a concrete backend.
Evidence: `test_stt_ladder` 9 tests; red-first (no `STT_LADDER`), then mutations: selection replaced by a constant primary → 5 fail, chosen-rung build replaced by a silent primary → 9. Full suite 511 OK. Branch `cluster/breaker-18-23`, base 83ea36ed, merge → "Already up to date".
Merger notes: `choose_rung`/`read_choices`/`CallRungs` (19/21) stay the only rung readers; ticket 65 wires `open_speech` into connect and must translate `LegFailed`/`LegUnreadable` into a visible call failure, never a managed handover, once the first frame is sent.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
