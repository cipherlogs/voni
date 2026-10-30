# 23: Model ladder: Spark, gateway, then fail

**What to build:** The record selects the model rung. An open Spark leg means zero model requests to Spark and the gateway answers; a speech failure never demotes a healthy model.

**Blocked by:** 15 (Breaker record and durable shared store), 17 (Breaker transitions on a fake clock)

**Status:** resolved

- [ ] The record decides the model rung; no per-call heuristic can override it.
- [ ] With the Spark leg open, a new call makes zero requests to Spark and uses the gateway model.
- [ ] A speech failure never changes the model rung.
- [ ] The rung actually used is recorded in the turn attribution.
- [ ] Removing the ladder makes a call attempt the open provider and the test fails.

## Answer

23 done — `cascade/ladders.py` gains `LLM_LADDER` (spark → gateway), `ModelSession` and `open_model()`, sharing one `_open_leg` path with ticket 22 so there is a single read/build/attribute implementation; `cascade/test_llm_ladder.py` is new (8 tests).
Selection: one durable `read_choices` per call and one factory call for the selected rung. With the llm record `open`, the Spark factory is never called (zero Spark streams; the built gateway stream has 0 requests before the turn) and the gateway answers; with it `closed`, Spark is used; flipping the record between calls moves the next call only. Attribution (`leg, provider, rung, reason`, `to_document()`) names the provider actually built, for turn attribution (ticket 108).
Fail visibly and decoupling: a missing gateway factory raises `LegFailed("llm", …)` naming the provider; a speech failure leaves the llm record `closed`/v1 and the next model choice primary; a model failure (429) leaves the stt record `closed` and the speech choice primary.
Judgments: `open_model` builds an `LLMStream` without calling `complete()` (the per-turn bound, retry policy and mid-reply rules are tickets 42/76); the factory is where a vendor client is constructed, so "zero requests to Spark" needs no network fake. The rung ids are `spark`/`gateway`, not the model id, because the attribution is about the provider, and `model_guard`/`MetaLLM` keep the Standard model id.
Evidence: `test_llm_ladder` 8 tests; red-first (no `LLM_LADDER`), then mutations: fallback aliased to primary → 5 fail, selection replaced by a constant primary → 9 (with 22's file). Full suite 511 OK. Branch `cluster/breaker-18-23`, base 83ea36ed, merge → "Already up to date".
Merger notes: the ladder walks rungs, not retries — 42 owns retry-once-before-first-token and never restarting mid-reply; 108 should consume `ProviderAttribution.to_document()` rather than re-deriving the provider.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
