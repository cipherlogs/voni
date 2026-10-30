# 138: A versioned protocol that refuses the unknown

**What to build:** The config carries a protocol version. The service refuses an unknown or missing version with a named error, and the browser surfaces it instead of hanging, so a half-deployed pair fails loudly.

**Blocked by:** 135 (Container host and two-instance topology), 65 (The browser sends a token, not a prompt)

**Status:** resolved

- [ ] The config carries a protocol version.
- [ ] The service refuses an unknown or missing version with a named error.
- [ ] The client surfaces that error to the browser rather than hanging.
- [ ] A half-deployed pair fails loudly instead of guessing.
- [ ] A mismatched version asserts the named refusal.

## Answer

# 138 — one protocol version; the unknown is refused by name

**Status: done.** Branch `cluster/deploy-136-139`, commit `d7568110`, base `33e85a57`.

- **One number:** `PROTOCOL_VERSION` (service) and `CASCADE_PROTOCOL_VERSION` (app) are pinned equal by `cascade/test_protocol_version.py`, which reads the TS export; the config frame already carries `protocolVersion` (ticket 65).
- **Named refusal before anything:** missing/unknown versions already refused first in `parse_browser_config`; error frames now carry `code: "protocol_version"`, and `transport` sends it before the body claim or any vendor socket.
- **Client fails loudly, not hangs:** `cascade-session.ts` parses the error `code`; a `protocol_version` refusal is surfaced through `onError` and tears the socket down (`abort`) without reporting a completed call. The end message's `protocolVersion` is parsed and checked against the client's, surfacing a mismatch on a call that did open.
- **Proof:** `cascade.test_protocol_version` 5 (parity, missing, mismatched, no backend opened ×2); TS `cascade-session.test.ts` +3 (refusal surfaces + teardown, end mismatch named, matching end clean). TS suite 2327 tests / 2326 pass / 1 skipped; `npm run typecheck` OK.
- **Merger note:** any test asserting an exact error frame shape may now see the added `code` key; none in the suite did.

_Implemented on `feat/meta-cascade`._
