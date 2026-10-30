# 141: Versions are visible and secrets stay in env

**What to build:** The service reports its code and protocol versions in the end message and health endpoint, and the artifact records app and service versions, so a version mismatch is visible before a cutover claim. Secrets come from host environment only.

**Blocked by:** 135 (Container host and two-instance topology), 136 (A short-TTL token binds the call and subject), 138 (A versioned protocol that refuses the unknown)

**Status:** resolved

- [ ] The service reports its code version and protocol version in the end message and health endpoint.
- [ ] The artifact records the app and service versions.
- [ ] A version mismatch is visible before a cutover claim.
- [ ] Every secret comes from host environment and none is committed; a repository scan fails on a key.
- [ ] No request log includes a credential.

## Answer

# 141 — Versions are visible and secrets stay in env

- `cascade.version`: build from `VOICE_PIPELINE_BUILD_VERSION`, then Fly's `FLY_IMAGE_REF`, else the named `unversioned` (never guessed); `PROTOCOL_VERSION` is imported from `cascade.token` (ticket 138 owns it — a test forbids a second assignment). `/healthz` returns `service/buildVersion/buildSource/protocolVersion`; the per-call end message adds `buildVersion` next to the existing `protocolVersion`.
- `deploy/versions.json` records the app version (pinned to `voni/package.json`), the service's host-supplied build and the protocol each half speaks. `deploy/topology.py:validate_versions` reads it with both code copies of the protocol number and fails by name on a mismatch → a visible deploy error before a cutover claim.
- `deploy/secret_scan.py` (wired into `topology.py`, also runnable alone): a key-shaped value, a URL with real userinfo, or a long secret assignment in any committed file fails as `path:line:kind` — the value is never echoed. `test_*`/`.test.ts`/fixtures are exempt; production code, config, docs and scripts are not.
- Tests (`cascade/test_version.py` 11, `test_deploy_versions.py` 12): report through `/healthz` and the end message, unversioned named, no second protocol constant, no secret value in a report, a log line carrying a secret is redacted, artifact parity + mismatch error, scan red/green and no-echo. Mutation-proved: dropping the end-message/`healthz` build fields fails those tests; disabling secret redaction fails the log test.
- Evidence: `voice-pipeline/cascade/version.py`, `cascade/test_version.py`, `deploy/versions.json`, `deploy/secret_scan.py`, `voice-pipeline/test_deploy_versions.py`, `docs/deploy/README.md` "Versions"/"Secrets". Suite 1903 → 1926.

_Implemented on `feat/meta-cascade`._
