# 106: Shed prefetch before a real turn

**What to build:** Under rate pressure, speculative work is cancelled and refused while the caller's turn is still served. A prefetch rejection never demotes a healthy provider.

**Blocked by:** 72 (Speculative prefetch that can never commit a turn), 31 (Speech close-code policy), 55 (Voice close policy: trigger, bug, expiry)

**Status:** resolved

- [ ] Under rate limiting, an exhausted quota, a concurrency limit or control-frame pressure, speculative prefetch is cancelled and refused.
- [ ] A real turn is still served while prefetch is shed.
- [ ] A prefetch rejection does not open the breaker; a real turn's rejection does.
- [ ] Prefetch never consumes the last unit a real turn needs.
- [ ] The real turn is served before prefetch under pressure.

## Answer

106 done — `cascade/prefetch.py` gains the shedding gate. `PressureSignal(kind, leg, code, remaining, detail)` encodes exactly the four spec triggers, with `pressure_from_llm_status(429)`, `pressure_from_stt_close(1013)`, `pressure_from_tts_close(3010)`, `quota_pressure(leg, remaining=…)` (None when the header is absent or positive) and `concurrency_pressure(leg)`; any other status/close returns `None` (a 500 or 1011 is not rate pressure, and nothing is invented).
`PrefetchSpeculator.observe_pressure(signal)` cancels the live ticket (`DropReason.SHED`, `prefetch_cancelled` counter) and refuses every subsequent `offer` (each refusal counted, no speculative request made) until `pressure_relieved()` — clearing is provider-driven, so there is no hold interval to guess. A shed ticket is never adoptable, so a shed prefetch can never commit a turn. The real turn path is untouched: end-to-end over `EventRules` + reply sink, the final is answered while prefetch is shed and `prefetch_started == 0`.
`PrefetchSpeculator.budget: RequestBudget` (new protocol: `remaining()`, `real_turns_waiting()`) is the capacity seam. `offer` refuses unless `remaining > real_turns_waiting`, i.e. the reserve is one unit per waiting real turn — the spec's "last unit" — so no cap/reserve/interval literal exists in the module and no threshold was invented to read. `remaining() is None` (no header) is not read as zero. (Read `thresholds.py`; it declares no prefetch/shed bound, and adding an open one would disable ticket 72's working prefetch, so nothing is registered here — see merger note.)
Breaker: `prefetch_failure_verdict(leg, code)` reuses `cascade.failures.classify` and downgrades only the class to `do_not_open`; `ShedDecision.verdict` is what the prefetch path records. Proved against the real `BreakerTransitions` + `MemoryStore`: the prefetch 429 leaves the llm leg closed, the same 429 via `classify("llm", 429)` on a real turn opens it.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 1313, OK (12 new in `cascade/test_prefetch_shedding.py`; `FakeClock`, no sleeps). Red-proofs: deleting the shed refusal fails 3, deleting the headroom check fails 3, removing the verdict downgrade fails 1, not dropping the live ticket on pressure fails 7.
Branch `cluster/prefetch-106`, base/integration tip `098fdf9d`, commit `5df2e772`; `git merge feat/meta-cascade` → "Already up to date".
Merger notes: (1) M06 must wire the adapters — `observe_pressure` on llm 429 / stt 1013 / tts 3010 / quota+concurrency headers, `pressure_relieved()` when the provider clears — and supply a `RequestBudget` from ticket 101/102's meter; nothing else in-tree constructs `PrefetchSpeculator` yet. (2) No thresholds.json edit: the reserve derives from waiting real turns and the remaining count comes from the meter, so there is no number to source; if the owner wants a bound anyway, `prefetch.reserve_units` belongs to ticket 04, not here. (3) `metrics.py` untouched — shed uses `prefetch_cancelled` (the same counter ticket 72 uses for a failed prefetch).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
