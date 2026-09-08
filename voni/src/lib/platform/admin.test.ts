import assert from "node:assert/strict";
import test from "node:test";
import { emailIsAllowlisted } from "./admin";

test("platform operator allowlist is exact, trimmed, and case-insensitive", () => {
  const allowlist = " owner@example.com, OPS@VONI.EXAMPLE ";
  assert.equal(emailIsAllowlisted("Owner@Example.com", allowlist), true);
  assert.equal(emailIsAllowlisted("ops@voni.example", allowlist), true);
  assert.equal(emailIsAllowlisted("owner+extra@example.com", allowlist), false);
  assert.equal(emailIsAllowlisted("", allowlist), false);
  assert.equal(emailIsAllowlisted("owner@example.com", undefined), false);
});
