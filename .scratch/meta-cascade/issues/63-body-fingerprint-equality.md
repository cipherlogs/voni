# 63: Served body fingerprint equals the minted one

**What to build:** The app reads back the served body and verifies its full fingerprint, including the account salt, against what it minted. A call cannot run a body nobody fingerprinted.

**Blocked by:** 57 (Stored-body field map)

**Status:** resolved

- [ ] The served body's full fingerprint equals the minted fingerprint.
- [ ] A mismatch is a named refusal that routes managed.
- [ ] The check runs on the body the app read back, not the body it intended to write.
- [ ] A test mutates one body field and observes the mismatch by name.

## Answer

63 fingerprint equality: done, green — 506 tests (+9 in `cascade/test_body_map.py`) on Python 3.14 venv; branch `cluster/body-58-25`, base `83ea36ed`, commit `8da4bf51`.
Rule: `stable_json` (sorted keys, compact separators, raw unicode) + `body_fingerprint(body, account_salt=...)` = sha256(canonical JSON ‖ NUL ‖ salt); the whole body is hashed, so an adapter-ignored field (`output.volume`) still moves the fingerprint.
Cross-language: the test pins one vector computed by running `agentBodyFingerprint`/`stableJson` from `voni/src/lib/agents/fingerprint.ts` under node — Python matches it byte for byte; the account salt is mixed in exactly as the TS function does, and two salts give different hashes.
Named refusal: `verify_served_body(served_body=..., minted_fingerprint=..., account_salt=...)` raises `BodyFingerprintMismatch` (`.minted`, `.served`, both named, salt never printed); a test mutates one field and observes it, and another proves the check reads the served body, not the intended one.
Routes managed: the mismatch reason fed to `routing.decide("all", tenant, refusal=...)` yields `managed` with zero cascade connections. Envelope/body-hash (64) and browser token (65) deliberately untouched; this is the app's fingerprint check only.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
