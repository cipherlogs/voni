# 100: Every billable unit comes from the wire

**What to build:** Money is metered from what the vendors report: speech audio seconds, model prompt/completion/cached/reasoning tokens, and voice billed characters. A unit the vendor did not report is unmeasured, never zero.

**Blocked by:** 75 (Call lifecycle and the end message)

**Status:** resolved

- [ ] Speech is metered by whole audio seconds processed.
- [ ] The model is metered by prompt, completion, cached and reasoning tokens.
- [ ] Voice is metered by the billed character count from termination.
- [ ] A unit the vendor did not report is unmeasured, never zero.
- [ ] A reconnect replay is metered because the vendor bills it.

## Answer

100 done — new `cascade/usage.py`: one append-only `UsageMeter` per call records only vendor-reported units, and `CallUsage.to_document()` is the per-leg/per-turn record ticket 101 prices and the end message carries.
Units: LLM prompt/completion/cached/reasoning tokens per turn (accepts the stream's `TurnUsage` or the raw usage chunk, reusing ticket 38's `parse_usage`); TTS billed characters plus audio/session seconds from the `Termination` `Billing` (ticket 54's precedence and `source` kept); STT audio in whole seconds from a vendor usage frame when supplied.
Invariant: an absent unit is `quantity: None`/`measured: false` with a source naming the absence (never zero); a measured zero (`cached_tokens: 0`) stays zero; call totals sum every recorded turn/session (a reconnect or retry is billed twice) and one unmeasured record makes the whole unit unmeasured, never a partial sum.
No rate table, cost, daily counter or ceiling — those remain 101/102/105.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1104, OK (20 new in `cascade/test_usage.py`; five mutations killed: zero-fill, drop floor, partial sum, overwrite-on-reconnect, coerce-to-zero). Branch `cluster/money-100`, base `cce8b788`, commit `dd5ed99c`; merge with `feat/meta-cascade` was already up to date.
Merger notes: STT is `unmeasured` today because the realtime protocol reports no usage frame — `record_stt` is the seam for when it does, and sending-side bytes are deliberately not used as a meter; `record_llm`/`record_tts`/`record_stt` must each be called once per vendor record (M06 orchestrator wiring), including an interrupted turn with `None`, or the call total undercounts; an empty leg is unmeasured, so 101 may only treat a provably-never-run leg as zero via ticket 108 attribution.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
