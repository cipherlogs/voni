import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALL_TOKEN_KIND,
  CALL_TOKEN_VERSION,
  signCallToken,
  verifyCallToken,
} from "./cascade-token";

const here = dirname(fileURLToPath(import.meta.url));
const VECTOR = JSON.parse(
  readFileSync(join(here, "../../../../voice-pipeline/cascade/call_token_vectors.json"), "utf8"),
) as {
  secret: string;
  call_id: string;
  subject: string;
  issued_at_ms: number;
  expires_at_ms: number;
  nonce: string;
  now_s: number;
  token: string;
};

test("the app mints the exact token the Python service verifies", () => {
  // The vector was produced by Node's crypto and is pinned on both sides
  // (ticket 136), so the two signers cannot drift.
  const token = signCallToken({
    secret: VECTOR.secret,
    callId: VECTOR.call_id,
    subject: VECTOR.subject,
    ttlMs: VECTOR.expires_at_ms - VECTOR.issued_at_ms,
    nonce: VECTOR.nonce,
    now: VECTOR.now_s * 1000,
  });
  assert.equal(token, VECTOR.token);
});

test("the token binds the call, the subject and an expiry", () => {
  const token = signCallToken({
    secret: "s",
    callId: "call-1",
    subject: "agent-1",
    ttlMs: 60_000,
    nonce: "n",
    now: 1_000_000_000_000,
  });
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  assert.deepEqual(payload, {
    kind: CALL_TOKEN_KIND,
    version: CALL_TOKEN_VERSION,
    call_id: "call-1",
    subject: "agent-1",
    issued_at_ms: 1_000_000_000_000,
    expires_at_ms: 1_000_000_060_000,
    nonce: "n",
  });
});

test("a fresh nonce makes every mint unique", () => {
  const base = {
    secret: "s",
    callId: "call-1",
    subject: "agent-1",
    ttlMs: 60_000,
    now: 1_000_000_000_000,
  };
  assert.notEqual(signCallToken(base), signCallToken(base));
});

test("verify refuses a tampered, expired or mis-bound token", () => {
  const secret = "s";
  const token = signCallToken({
    secret,
    callId: "call-1",
    subject: "agent-1",
    ttlMs: 60_000,
    nonce: "n",
    now: 1_000_000_000_000,
  });

  assert.ok(verifyCallToken(token, { secret, callId: "call-1", subject: "agent-1", now: 1_000_000_001_000 }));
  assert.equal(
    verifyCallToken(token, { secret, callId: "call-2", subject: "agent-1", now: 1_000_000_001_000 }),
    null,
  );
  assert.equal(
    verifyCallToken(token, { secret, callId: "call-1", subject: "agent-2", now: 1_000_000_001_000 }),
    null,
  );
  assert.equal(
    verifyCallToken(token, { secret, callId: "call-1", subject: "agent-1", now: 1_000_000_060_000 }),
    null,
  );
  assert.equal(
    verifyCallToken(token.replace(/\.[0-9a-f]+$/, `.${"0".repeat(64)}`), {
      secret,
      callId: "call-1",
      subject: "agent-1",
      now: 1_000_000_001_000,
    }),
    null,
  );
});
