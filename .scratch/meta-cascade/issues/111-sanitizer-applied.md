# 111: The sanitizer runs on every line

**What to build:** The shared sanitizer is applied to the cascade stream exactly as to the managed stream. A forbidden key rejects the line; a key-shaped reason is redacted; a raw vendor handshake is never logged.

**Blocked by:** 07 (One sanitizer for both event streams), 107 (One event envelope and reader refusal)

**Status:** resolved

- [ ] The shared sanitizer runs on every line before write; a forbidden key rejects the line by name.
- [ ] A reason carrying a URL or a key-shaped value is redacted.
- [ ] A raw vendor handshake is never logged, and a test that logs it fails.
- [ ] Existing consumers see the same allowed fields they see today.

## Answer

111: Mechanism (stated as required): the writer is Python (`EventStream` in `cascade/events.py`), the rule source is `voni/src/lib/demo/event-sanitizer.ts`; `cascade/sanitizer.py` is a **Python-callable copy** and `cascade/test_sanitizer.py` is the parity test — it parses the TS source and asserts the forbidden set (14 keys), both regex sources + `i` flag, `[redacted]`, depth 4, 500 chars and `…` match, and it copies the TS test's expected values. No second denylist with different rules.
Every line goes through `EventStream.__call__` → `sanitize_fields` before the only sink write; a forbidden key raises `ForbiddenEventKey` (dotted path honoured, e.g. `handshake.authorization`) and **nothing is written**; the exception never echoes a value.
`test_a_raw_vendor_handshake_is_never_logged` feeds the exact Meta frame (`authorization.accessToken: Bearer …`) and fails the write; a `provider_fallback` reason with a URL userinfo or `Bearer` is redacted on the written line; allowed fields are byte-identical (`test_existing_consumers_see_the_same_allowed_fields`).
Evidence: `cascade.test_sanitizer` 9 + 5 stream tests; Python suite `939 tests OK`; TS `event-envelope`/`event-sanitizer`/`eval-events` 29 pass; full `npm test` 2089 pass, 1 skipped, 0 fail; lint 0 errors (2 pre-existing warnings in `scripts/reviewer-pack.mts`).
Merger notes: `events.py`'s 107 docstring no longer claims Python never writes; `seq`/artifact paths untouched; no `artifact-reader.ts` edits. Branch `cluster/events-109-111`, base `8ff36c2a`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
