# 60: A body with an LLM override refuses the cascade

**What to build:** A tenant's bring-your-own model is never silently replaced. A non-empty model override refuses the cascade and routes managed with a recorded reason; an empty array is the documented revert and is allowed.

**Blocked by:** 57 (Stored-body field map)

**Status:** resolved

- [ ] A non-empty model override refuses the cascade and routes managed with a recorded reason.
- [ ] An empty model array is allowed and is not treated as an override.
- [ ] The refusal is a routing decision, not a fallback event, and does not contaminate a later cascade run.
- [ ] Deleting the refusal makes the test fail.

## Answer

60 LLM override refusal: done, green — 468 tests (+5 in `cascade/test_body_map.py`) on Python 3.14 venv; branch `cluster/body-58-25`, base `83ea36ed`, commit `9ccb9adc`.
Rule: `_reject_llm_override` raises `LlmOverrideRefusal` naming the model(s) for any non-empty `llm` array; absent, `null` and `[]` all adapt normally (`[]` is the documented revert); a non-list `llm` is a named `BodyFieldError`.
Routing, not fallback: a test feeds the refusal text into `cascade.routing.decide("all", tenant, refusal=...)` and asserts `disposition == "managed"`, zero cascade connections and the model name in `reason`; nothing in the module emits or counts a fallback event.
No contamination: no module state — after a refused body, a later `llm: []` body adapts and `decide("all", subject)` returns `cascade` with an empty reason.
Deleting the refusal fails `test_a_non_empty_model_override_refuses_the_cascade_by_name` (red proved first with the import missing; the test also names the model, so a broad `except` cannot fake it).

Superseded by 159: a non-empty `llm` is now constructed from the stored body; an unconstructible override fails visibly instead of routing managed.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
