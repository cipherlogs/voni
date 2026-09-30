import assert from "node:assert/strict";
import test from "node:test";
import { emailIsAllowlisted, requireInvitedEmail } from "./admin";

test("platform operator allowlist is exact, trimmed, and case-insensitive", () => {
  const allowlist = " owner@example.com, OPS@VONI.EXAMPLE ";
  assert.equal(emailIsAllowlisted("Owner@Example.com", allowlist), true);
  assert.equal(emailIsAllowlisted("ops@voni.example", allowlist), true);
  assert.equal(emailIsAllowlisted("owner+extra@example.com", allowlist), false);
  assert.equal(emailIsAllowlisted("", allowlist), false);
  assert.equal(emailIsAllowlisted("owner@example.com", undefined), false);
});

test("sign-in gate rejects non-allowlisted emails with invite_only", async () => {
  process.env.VONI_ADMIN_EMAILS = "owner@example.com";
  await requireInvitedEmail(" Owner@Example.com ");
  await assert.rejects(requireInvitedEmail("stranger@example.com"), (e: { body?: { code?: string } }) => e.body?.code === "invite_only");
});
