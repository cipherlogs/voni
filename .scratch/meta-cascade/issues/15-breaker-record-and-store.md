# 15: Breaker record and durable shared store

**What to build:** One durable, versioned record per leg (speech, model, voice), shared across every instance, read before the first frame of every call and written on every transition. The record is the only thing that decides which rung a leg uses.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] The record carries leg, provider, state, opened/failure/success/probe timestamps, at most three probe successes, manual override, trigger, reason and record version, and refuses an unknown version.
- [ ] Two instances reading the same leg see the same record; there is no in-process cache that can disagree.
- [ ] A failed read returns the last durable state and never a synthetic closed state.
- [ ] A write is a compare-and-set on the record version, so two writers cannot silently overwrite each other.

## Answer

15 done — `cascade/store.py` (generic `DurableStore` protocol + `StoredDocument` version slot + `MemoryStore` fake with outage switches + lazy-connection `SqliteStore`) and `cascade/breaker.py` (`ProviderBreakerRecord` v1 with the exact spec document keys, `ProbeSuccess`, `BreakerTrigger`, strict unknown-version/unknown-field refusal, `bumped()`, `effective_state()`).
Read/write contract: `Breaker(store, probe_interval_s=<injected>)` — no number invented; `.read(leg)` always hits the store (no in-process cache), raises `BreakerRecordMissing` when unset and `BreakerRecordCorrupt` when leg/row-version disagree; never synthesises `closed`. Outage: `SqliteStore.read` returns the last durable document per key, else `StoreUnavailable` (MemoryStore raises).
CAS: `write(record)` expects `record.record_version - 1` (create = version 1, expected None); a stale writer gets `False`, must re-read and `bumped()`; nothing is silently overwritten.
Tests: `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 129, OK (92 at dispatch + 12 store + 25 breaker). Red proven: module-missing red first, then mutations — `expected_version=None` kills 3 CAS tests, staleness `False` and the deleted last-durable fallback each fail.
Merger notes: branch `ticket/15-breaker-record-and-store`, base 20751132, `git merge feat/meta-cascade` → "Already up to date"; `recordVersion` is the monotonic CAS counter (v1 = first write), "unknown version" = non-int/<1/missing refused by `UnsupportedRecordVersion`; `SqliteStore` is single-host/shared-volume only — tickets 135/139 still need an asyncpg adapter behind `DurableStore` (adds `ping()` for readiness); no thresholds, ticket 17 owns transitions, 19 owns the pin-to-rung application.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
