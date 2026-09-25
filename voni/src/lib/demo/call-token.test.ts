import test from "node:test";
import assert from "node:assert/strict";
import { CALL_TOKEN_TTL_S, signDemoCall, verifyDemoCall } from "./call-token";

const KEY = "test-key";

test("a minted call token verifies until it expires", () => {
  const token = signDemoCall(KEY, 1_000_000);
  const call = verifyDemoCall(KEY, token, 1_000_000);
  assert.ok(call?.callId);
  assert.ok(verifyDemoCall(KEY, token, 1_000_000 + (CALL_TOKEN_TTL_S - 1) * 1000));
  assert.equal(verifyDemoCall(KEY, token, 1_000_000 + CALL_TOKEN_TTL_S * 1000), null);
});

test("each call gets its own id", () => {
  const a = verifyDemoCall(KEY, signDemoCall(KEY, 0), 0);
  const b = verifyDemoCall(KEY, signDemoCall(KEY, 0), 0);
  assert.notEqual(a?.callId, b?.callId);
});

test("tampered, foreign, or malformed tokens are rejected", () => {
  const token = signDemoCall(KEY, 0);
  const [id, exp, sig] = token.split(".");
  assert.equal(verifyDemoCall(KEY, `${id}.${Number(exp) + 9999}.${sig}`, 0), null, "extended expiry");
  assert.equal(verifyDemoCall("other-key", token, 0), null);
  assert.equal(verifyDemoCall(KEY, "", 0), null);
  assert.equal(verifyDemoCall(KEY, "a.b", 0), null);
  assert.equal(verifyDemoCall(KEY, `${token}x`, 0), null);
});
