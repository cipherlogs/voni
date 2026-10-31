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
  const parts = token.split(".");
  const withPart = (index: number, value: string) =>
    parts.map((part, at) => (at === index ? value : part)).join(".");
  assert.equal(verifyDemoCall(KEY, withPart(1, String(Number(parts[1]) + 9999)), 0), null, "extended expiry");
  assert.equal(verifyDemoCall(KEY, withPart(2, String(Number(parts[2]) + 9999)), 0), null, "moved start");
  assert.equal(verifyDemoCall("other-key", token, 0), null);
  assert.equal(verifyDemoCall(KEY, "", 0), null);
  assert.equal(verifyDemoCall(KEY, "a.b", 0), null);
  assert.equal(verifyDemoCall(KEY, `${token}x`, 0), null);
});

test("a re-mint in the same call keeps its token (start, budgets); a dead one gets a fresh call", async () => {
  const { carryDemoCall, signDemoCall, verifyDemoCall, CALL_TOKEN_TTL_S } = await import("./call-token");
  const first = signDemoCall("k", 1_000_000);
  assert.equal(verifyDemoCall("k", first, 1_000_000)?.startedAt, 1_000_000);
  assert.equal(carryDemoCall("k", first, 1_000_000 + 60_000), first);
  assert.notEqual(carryDemoCall("k", first, 1_000_000 + (CALL_TOKEN_TTL_S + 1) * 1000), first, "expired");
  assert.notEqual(carryDemoCall("k", "forged.1.x", 1_000_000), "forged.1.x");
  assert.notEqual(carryDemoCall("k", undefined, 1_000_000), undefined);
});

test("a hold return signs a fresh token for the same call id", async () => {
  const { signDemoCallFor, verifyDemoCall, signDemoCall } = await import("./call-token");
  const first = signDemoCall("k", 1_000_000, "tag-1");
  const callId = verifyDemoCall("k", first, 1_000_000)?.callId;
  assert.ok(callId);

  const resumed = signDemoCallFor("k", callId, 2_000_000, "tag-2");
  assert.notEqual(resumed, first, "the previous token is never reused");
  const call = verifyDemoCall("k", resumed, 2_000_000);
  assert.equal(call?.callId, callId, "the same call continues");
  assert.equal(call?.tagId, "tag-2", "the token carries the tag it was issued with");
});

test("a hold return keeps the call's original start and window with a fresh token", async () => {
  const { signDemoCallFor, verifyDemoCall, signDemoCall, CALL_TOKEN_TTL_S } = await import(
    "./call-token"
  );
  const startedAt = 1_000_000;
  const first = signDemoCall("k", startedAt, "tag-1");
  const callId = verifyDemoCall("k", first, startedAt)?.callId;
  assert.ok(callId);

  // The visitor comes back from a hold a little later. The continuation is a
  // new token, but the call still started at its first start: the inbox
  // lookback (runCheckEmail's `call.startedAt`) does not move.
  const returnedAt = startedAt + 30_000;
  const resumed = signDemoCallFor("k", callId, returnedAt, "tag-1", startedAt);
  assert.notEqual(resumed, first, "a resumed call never reuses the old token");
  const call = verifyDemoCall("k", resumed, returnedAt);
  assert.equal(call?.callId, callId);
  assert.equal(call?.startedAt, startedAt, "the call's first start survives the hold return");
  assert.equal(call?.tagId, "tag-1");
  assert.equal(
    verifyDemoCall("k", resumed, startedAt + (CALL_TOKEN_TTL_S - 1) * 1_000)?.startedAt,
    startedAt,
    "the token stays valid up to the original window",
  );
  assert.equal(
    verifyDemoCall("k", resumed, startedAt + CALL_TOKEN_TTL_S * 1_000),
    null,
    "a hold return never extends the call's credential lifetime",
  );
  // Two returns at the same instant are still two distinct tokens.
  assert.notEqual(
    signDemoCallFor("k", callId, returnedAt, "tag-1", startedAt),
    signDemoCallFor("k", callId, returnedAt, "tag-1", startedAt),
  );
});

test("a call token can name its Test tag; a carry keeps it only for the same tag", async () => {
  const { carryDemoCall, signDemoCall, verifyDemoCall } = await import("./call-token");
  const tagged = signDemoCall("k", 1_000_000, "tag-1");
  assert.equal(verifyDemoCall("k", tagged, 1_000_000)?.tagId, "tag-1");
  assert.equal(verifyDemoCall("k", signDemoCall("k", 1_000_000), 1_000_000)?.tagId, null);
  assert.equal(verifyDemoCall("k", tagged.replace("tag-1", "tag-2"), 1_000_000), null, "the tag is signed");
  assert.equal(carryDemoCall("k", tagged, 1_000_000, "tag-1"), tagged);
  assert.equal(verifyDemoCall("k", carryDemoCall("k", tagged, 1_000_000, "tag-9"), 1_000_000)?.tagId, "tag-9");
});
