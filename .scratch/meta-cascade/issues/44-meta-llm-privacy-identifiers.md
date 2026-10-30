# 44: No caller identity in model identifiers

**What to build:** No caller name, phone, email or raw internal id is sent as a model user or safety identifier. If either field is used at all, it is a salted hash of an internal id.

**Blocked by:** 35 (Standard-only model construction guard)

**Status:** resolved

- [ ] No caller name, phone number, email or raw internal id is sent as a user or safety identifier.
- [ ] If either field is used, it is a salted hash of an internal id, and the salt is absent from the artifact.
- [ ] A test scans the built request for the fixture's identifying values and fails on a hit.
- [ ] Prompt caching is not enabled as a latency default; it stays a reviewed decision.

## Answer

Ticket 44 done: `safety_identifier` is opt-in (`internal_id` + `identifier_salt`/`META_IDENTIFIER_SALT`) and is only ever `privacy_identifier()` = SHA-256 of `salt NUL internal_id`; there is no `user` field at all, and an internal id without a salt (or blank) refuses at construction before any request.
The identifier is stable for the same id+salt (so vendor abuse detection survives retries), changes with a different salt or id, differs from the unsalted digest, and the salt never appears in the payload, headers or turn record; the request scan covers the fixture's caller name, phone, email, raw call id and salt.
Prompt caching is not enabled: no `prompt_cache_key`/`prompt_cache_retention`/`cache`/`store` in the payload and no constructor switch to turn it on (a `TypeError` test pins that absence); it stays a reviewed ZDR decision.
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_privacy` = 13 OK; full discover = 494 OK (red-first: `privacy_identifier` absent; mutations "send the raw id" → 4 failures and "allow an unsalted hash" → red).
Files: `voice-pipeline/cascade/meta_llm.py`, `voice-pipeline/cascade/test_meta_llm_privacy.py`. Branch `cluster/llm-37-44`, base 83ea36ed.
Merger notes: the pinned digest vector assumes the NUL separator (sha256 of `pepper\x00call-123`); deployment must set `META_IDENTIFIER_SALT` if M06/M08 wire an identifier, otherwise the field stays absent by default.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
