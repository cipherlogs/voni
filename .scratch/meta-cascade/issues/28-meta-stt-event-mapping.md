# 28: Event mapping: start, partial, end, complete

**What to build:** The vendor's endpointing events map to the internal contract: a turn opens, partials are cumulative and belong to the most recent start, the end marks the boundary and the completion carries the authoritative text.

**Blocked by:** 26 (Meta speech handshake and injected socket seam)

**Status:** resolved

- [ ] Speech start opens a turn and carries the vendor turn id; a partial carries no id and belongs to the most recent start.
- [ ] Speech end and speech complete carry the same turn id and map to distinct internal events.
- [ ] Unknown event types are ignored, and a server binary frame is ignored.
- [ ] An error event fails the call and names the session.
- [ ] No word timestamps or confidence are invented; the adapter never emits them.

## Answer

28 done — `cascade/meta_stt.py` maps the vendor stream onto distinct internal events: `SpeechStart(turn_id)`, `providers.PartialTranscript(text)` (no id at all), `SpeechEnd(turn_id)` and `SpeechComplete(text, turn_id)` (subclass of `FinalTranscript`, so existing final handling still sees one final).
Attribution: `speechStart` stores the latest `turnId` and is the only thing that sets it; `transcript` has no id and is dropped with a WARNING when no start preceded it; `speechEnd`/`speechComplete` require their own `turnId` and are not guessed from the latest start (an event without one is ignored and logged).
Robustness: unknown types (`audioProgress`, `someFutureEvent`, additive fields on known events), server binary frames and non-JSON text are ignored; an `error` event raises `MetaStreamError` naming `call-123:0`, makes `.reason` visible and records it in `failure_reason` — the credential never appears.
No invented metadata: fixtures carrying `confidence`, `words`, `timestamps`, `start`/`end` map to events whose dataclass fields are exactly `{turn_id}`, `{text}`, `{text, turn_duration_ms, turn_id}`; a test pins the field sets.
Red/green: `cascade/test_meta_stt_events.py` (15 tests) red at import before the event classes existed; total suite 471 OK at `e8b08015`. Seam for 67/33: import `SpeechStart`/`SpeechEnd`/`SpeechComplete` from `cascade.meta_stt`; `SpeechComplete.turn_id` is the provider id the `TurnStateStore` keys on.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
