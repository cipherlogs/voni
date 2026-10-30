# 61: Body eligibility refusals

**What to build:** Bodies the cascade cannot represent are refused by name and routed managed, each with its own reason: no fixed Locale, an unbound voice, an invalid tool name, a missing system prompt, over-limit keyterms, or a language the speech vendor does not support.

**Blocked by:** 57 (Stored-body field map), 46 (Voice binding table)

**Status:** resolved

- [ ] A body with no fixed Locale is refused; automatic language detection is not eligible on this slice.
- [ ] A voice absent from the binding table is refused by name.
- [ ] A tool name with more than one dot or an invalid character is refused by name.
- [ ] A body with no system prompt is refused as a contract violation.
- [ ] Over-limit keyterms and an unsupported language code refuse by name; nothing is truncated or dropped silently.
- [ ] Each refusal routes managed with its reason through the eligibility evaluator.

## Answer

61 body eligibility refusals: done, green — 492 tests (+24: 6 in `cascade/test_body_map.py`, 18 in new `cascade/test_eligibility.py`) on Python 3.14 venv; branch `cluster/body-58-25`, base `83ea36ed`, commit `b8cce562`.
Refused by name: auto language detection (no/empty `input.language_codes`), unbound voice (`juergen`, reason carries the 422 evidence), unknown voice, missing/blank `system_prompt` (contract violation), unsupported language code, and tool names with more than one dot or characters outside letters/digits/underscore/dash (single dot allowed).
Keyterms: the vendor keyword cap is an injected `keyterm_limit`, never a number in code; over-limit refuses with the count + limit in the reason, and the refused config still carries every keyterm — nothing truncated or dropped.
Every refusal routes managed through `cascade/eligibility.py` (`evaluate_body` → `disposition="managed"` + named `Refusal`s + `events()` of type `eligibility_refusal`, never `provider_fallback`); a table test covers all seven refusal classes plus a valid body.
MERGER NOTE: `keyterm_limit` has no home in `thresholds.json` yet (ticket 03/04 own that file); production wiring must supply it from a declared `stt.keywords_max` bound or keyterm-bearing bodies cannot be judged — I did not add a bound because it would break `test_thresholds.py`'s open-bound parity and edit another ticket's files.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
