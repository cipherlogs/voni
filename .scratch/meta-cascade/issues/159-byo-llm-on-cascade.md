# 159: BYO LLM bodies run on cascade

**What to build:** A stored body carrying an `llm` override is no longer refused by the cascade. The service constructs an OpenAI-compatible model client from the stored body's one provider entry (`base_url`, `model`, `api_key`), server-side only, and runs the same request/tool/failure contract. Managed is no longer the BYO path after cutover.

**Blocked by:** 57 (Stored-body field map), 60 (LLM override refusal — this ticket replaces that refusal), 36 (Chat Completions request contract), 42 (Model failure policy by phase), 84 (Tool failure mapping)

**Status:** resolved

**Owns:** voice-pipeline/cascade/body_map.py, voice-pipeline/cascade/meta_llm.py, voice-pipeline/cascade/eligibility.py

- [ ] `llm: []` is still the documented revert and uses the default Meta rung; one entry constructs the BYO client; more than one is refused by name.
- [ ] The provider key is read server-side from the signed body, never logged, never emitted in an event or artifact, and never sent to the browser.
- [ ] The BYO client honours the same request contract (streaming, usage, tools, message assembly) and failure policy as the default rung; a request-contract deviation fails the call visibly.
- [ ] A body whose override is missing a base URL/model/key, or whose client cannot be constructed, fails the call with a named error before any vendor socket — it does not route managed.
- [ ] Per-turn attribution names the BYO provider and model, not `muse-spark-1.3`.
- [ ] The Standard-only guard still applies to the default Meta rung; it is not applied to a tenant's chosen model.
- [ ] Eligibility no longer refuses a non-empty `llm`; it validates that the override is constructible.
- [ ] Tests: a fake HTTP session proves the request shape, a missing key is refused, the key never appears in a serialized event, and the old refusal is gone (deleting the construction fails the test).

## Answer

159 BYO LLM on cascade: done, green — 1674 tests on Python 3.14 venv; 17 new in `cascade/test_byo_llm.py` plus 7 rewritten in `test_body_map.py`.
Files: `cascade/{body_map.py,meta_llm.py,eligibility.py,test_body_map.py,test_call.py,test_eligibility.py,test_byo_llm.py}` @ `69b2d9d4`, branch `cluster/all-159-160`, base `fa4d1971`; `feat/meta-cascade` merge "Already up to date".
Body: `llm` is a mapped field — absent/`[]` → `None` (default Meta rung), one entry → `LlmOverride`, >1 → `MultipleLlmOverridesError`; missing/blank `base_url`/`model`/`api_key`, non-http(s) base URL or an unknown entry key fails by name before any socket; eligibility's new `llm` predicate re-reads it, so a non-empty override is eligible and an unconstructible one refuses by name.
Client: `build_byo_client`/`construct_byo_model` reuse the same request builder, message assembly, tools, SSE/turn record and failure policy; the Standard-only guard is off for the tenant model and its optional `reasoning_effort` is sent verbatim (`"none"` allowed); `byo_attribution` names `host/model` (never `muse-spark-1.3`).
Red: new file fails on base `fa4d1971` (`ImportError: cannot import name 'LlmOverride'`, 1 error) and `test_an_unconstructible_override...`/call tests fail on the old refusal; key is repr/document/event-free (`repr`, `to_document`, emitted attribution JSON asserted) and never falls back to `META_API_KEY`.

_Implemented on `feat/meta-cascade`._
