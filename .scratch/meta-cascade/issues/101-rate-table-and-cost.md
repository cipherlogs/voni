# 101: A named rate table and reproducible cost

**What to build:** A named, versioned rate table prices every unit, and a call's cost is reproducible from recorded native units plus that version. A price change is a new version, never an edit.

**Blocked by:** 100 (Every billable unit comes from the wire)

**Status:** resolved

- [ ] A named, versioned table carries per-leg rates including cached input and reasoning tokens.
- [ ] Every cost cites its rate-table version.
- [ ] A unit missing from the table makes the total unmeasured, not a partial sum presented as complete.
- [ ] A price change is a new version; an old artifact keeps its own.
- [ ] A known call's cost is computed from recorded units and pinned by a test.

## Answer

101 done — `cascade/cost.py` prices ticket 100's recorded units against `cascade/rates/v1.json`; `cost_call(usage)` returns per-leg + total cost with `rateTable {name, version, currency}` in every document. Rates: Meta STT $0.18/audio-hour (0.00005/s), muse-spark-1.3 Standard $1.25 input / $4.25 output / $0.15 cached per 1M, reasoning at the output rate (a completion detail, not additive), AssemblyAI TTS $15/1M characters; TTS audio/session seconds are a sourced `0` (vendor bills characters only). Every rate carries unit, source, vendor https URL and read date in the record.
Invariants: a vendor-absent unit makes its leg and the total unmeasured (never zero); a rate the table lacks, or declares OPEN, is named in the reason (and `RateTable.require` raises `UnknownRateError`/`OpenRateError`) — no default; a detail larger than its parent is unmeasured by name; the same units always give the same document. A price change is `rates/v2.json`; a test proves v2 moves the cost while the v1 artifact keeps version 1, and all eight v1 prices are pinned.
Hand-worked pin: 1M prompt/250k cached/200k completion/50k reasoning + 90 STT seconds + 1,000 TTS chars = $1.8445 (test `known_call_usage`), so the expected number does not come from the code.
Tests: `cd voice-pipeline && …/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 1324, OK (23 new in `cascade/test_cost.py`; five mutations killed: missing-rate→0, unmeasured→0, open→0, no detail netting, in-place retune). Branch `cluster/money-101`, base `098fdf9d`, commit `75e0b3c2`; merge of `feat/meta-cascade` → already up to date.
Merger notes: 102 should consume `CallCost.amount`/`.leg()` and the document; 105 must treat `amount is None` / `require_amount()`'s `UnmeasuredCostError` as “no ceiling stop”, not zero. M06 must record every leg (an empty leg is unmeasured by design). If the LLM rung can run a model with different prices (Contributor tier or a fallback model), add a new rate-table version keyed to that model before pricing it — this table names the Standard tier only. No counter, ceiling, budget or orchestrator wiring here.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
