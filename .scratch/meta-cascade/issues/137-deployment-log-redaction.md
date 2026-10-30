# 137: No credential in any log

**What to build:** The socket query token is redacted, and the vendor handshake body never appears in an access log, error log or crash dump, because the credential travels inside it.

**Blocked by:** 135 (Container host and two-instance topology), 07 (One sanitizer for both event streams)

**Status:** resolved

- [ ] The socket query token never appears in an access log, error log or crash dump.
- [ ] The vendor handshake body never appears in any log; a test that logs the request body fails.
- [ ] Other secrets are absent from logs: vendor keys, the tool secret, the signing secret and the database URL.
- [ ] A log-scanning test feeds a request through logging and asserts the credential is absent.

## Answer

# 137 — no credential in any log

**Status: done.** Branch `cluster/deploy-136-139`, commit `ef7a58bd`, base `33e85a57`.

- **Built:** `cascade/log_redaction.py`: `RedactingFilter`, `redact_text`, `redact_value`, `install_log_redaction`. It reuses the one sanitizer source (`cascade.sanitizer`: forbidden key names, key-shaped values, URL userinfo) and adds only the log-specific carriers: query credentials (`?token=…`), JSON credential fields (`"callToken":"…"`), and whole-line replacement of a vendor handshake (`audioEncoding`/`partialMode`/`emitAudioProgress`). Secret env values (vendor keys, tool secret, signing secret, `DATABASE_URL`) are replaced everywhere, including `record.exc_text` crash dumps.
- **Installed:** `create_app` installs it and a process-wide log record factory, so uvicorn handlers configured later (and records from child modules) are covered too; idempotent.
- **Proof:** `cascade.test_log_redaction` 11 — real Meta `open()` over a scripted socket sends the handshake (asserted present on the wire) while every emitted record is scanned clean; a deliberately logged handshake body, config frame, exception traceback and each secret are all absent. Tests were red before the module existed.
- **Docs:** `docs/deploy/README.md` records the redaction gate and the handshake rule.
- **Merger note:** the record factory is global once `server` is imported; that is intentional (one gate), and it does not alter non-log test assertions (full suite green).

_Implemented on `feat/meta-cascade`._
