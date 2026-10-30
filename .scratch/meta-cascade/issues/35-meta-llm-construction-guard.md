# 35: Standard-only model construction guard

**What to build:** The model backend refuses a Contributor-tier model at construction, before any request, and refuses a model outside the Standard allowlist by name.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] A model id containing the contributor tier marker is rejected at construction with a named error.
- [ ] A model id outside the Standard allowlist is rejected by name.
- [ ] The rejection happens before any request is built; removing the guard makes its test fail.
- [ ] The error names the model and the reason, so a privacy decision is not rediscovered as a runtime surprise.

## Answer

# 35 — Standard-only model construction guard

- `voice-pipeline/cascade/model_guard.py` exposes `ModelGuardError(ValueError)`, `STANDARD_MODELS = ("muse-spark-1.3",)`, `DEFAULT_MODEL`, `assert_standard_model(model_id)` and `resolve_model(model_id=None)`; only the confirmed Standard id is listed, nothing invented.
- Contributor ids are refused first (marker `-contributor`, case-insensitive) with a reason naming Contributor training on caller name/budget/financing/phone content; any other id outside the allowlist is refused by name with the allowed list, so the guard fires before a request body exists.
- Ticket 36 should call `resolve_model(model_id)` as the first statement of the client constructor and send the returned id as `model`; `resolve_model(None or "")` yields `muse-spark-1.3`, `assert_standard_model` refuses empty/non-string ids by name.
- Evidence: `cd voice-pipeline && .../python -m unittest discover -s . -p 'test_*.py'` → 102 tests OK (10 new); guard deleted in a scratch mutation → 6 failures, restored → OK.
- `cascade/__init__.py` landed empty (required for unittest discovery); no shared files edited, so merge was a no-op on top of 20751132.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
