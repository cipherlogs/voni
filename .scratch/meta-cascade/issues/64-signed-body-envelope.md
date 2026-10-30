# 64: Signed body envelope and hash verification

**What to build:** The app sends the body with its hash inside a signed envelope over the authenticated service channel. The service verifies both the envelope and the hash before opening any vendor socket, and a body that does not match is refused by name.

**Blocked by:** 63 (Served body fingerprint equals the minted one)

**Status:** resolved

- [ ] The app signs an envelope over the body hash and the call identity.
- [ ] The service verifies the envelope and the body hash before any vendor socket.
- [ ] A body whose hash does not match the envelope is refused by name.
- [ ] The envelope cannot be replayed onto another call id.
- [ ] No secret or raw body appears in a log.

## Answer

# 64 — signed body envelope and hash verification

- `cascade/envelope.py` adds `sign_body` (app: ticket 63 fingerprint check first, then body hash + HMAC over call identity/lifetime) and `verify_envelope` (service: HMAC → expiry → call-id binding → body hash, all named refusals, pure, no sockets, no logging).
- The TTL is never invented: `sign_body(ttl_ms=None)` reads `envelope.ttl_ms` from `cascade/thresholds.json`, declared OPEN with ticket `04`; while open it raises `UnsetBoundError` naming the bound and ticket.
- `envelope_vectors.json` pins one cross-language vector (Node crypto hashes + `openssl` HMAC), so the TypeScript signer and this verifier cannot drift; the test asserts the secret/account salt/raw body never appear in errors, reprs, logs or the wire message.
- Merge note: one shared-file edit outside my files — `thresholds.json` gained OPEN `envelope.ttl_ms`, and `test_thresholds.py` `OPEN_BOUNDS` gained the matching line (the registry-drift pin goes red without it).
- Tests: 19 new (`cascade.test_envelope`); full suite from `voice-pipeline/`: 803 OK. Each refusal check was deleted and its test proved red before restoring.

Evidence: `voice-pipeline/cascade/envelope.py`, `test_envelope.py`, `envelope_vectors.json`; branch `cluster/envelope-64`, commit `3d79d64f`, base `03ad6476`.

**Seam 65 calls** (after the browser config names call/agent/protocol, before any voice binding or vendor socket):

```python
from cascade.envelope import verify_envelope
verified = verify_envelope(      # raises a named EnvelopeError subclass
    wire_message,                # {"envelope": {...}, "body": {...}} from the app's authenticated channel
    secret=hmac_secret,          # host env; never logged
    call_id=call_id,             # the id the browser's call token names
    clock=clock,                 # injected; time.time in production
)
config = adapt_body(verified.body)   # verified.agent_id is available for 65's own agent check
```

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
