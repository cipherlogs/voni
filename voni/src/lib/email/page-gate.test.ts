/**
 * The `/email` page gate is a pure module: the digest format, the comparison
 * and the cookie attributes are what the page and the unlock action both rely
 * on, and the node runner can execute them directly.
 *
 * The point of these tests is that the page digest cannot be confused with the
 * control-secret digest. If the two schemes ever collapse into one, a control
 * cookie would open the page gate (or a gate cookie would unlock the panel).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PAGE_COOKIE,
  isPageUnlocked,
  pageGateCookieOptions,
  pagePasswordDigest,
} from "./page-gate";

const here = dirname(fileURLToPath(import.meta.url));
const PASSWORD = "correct horse battery staple";

test("the page digest is stable and domain-separated from the control secret", () => {
  const pageDigest = createHash("sha256")
    .update(`voni:email-page:${PASSWORD}`, "utf8")
    .digest("hex");
  assert.equal(pagePasswordDigest(PASSWORD), pageDigest);
  assert.match(pagePasswordDigest(PASSWORD), /^[0-9a-f]{64}$/);

  // The control cookie is `sha256(secret)` with no prefix. The same password
  // must produce a different value in each scheme.
  const controlStyle = createHash("sha256").update(PASSWORD, "utf8").digest("hex");
  assert.notEqual(pagePasswordDigest(PASSWORD), controlStyle);
  assert.notEqual(pagePasswordDigest(PASSWORD), pagePasswordDigest(`${PASSWORD} `));
});

test("the gate cookie name is the documented one", () => {
  assert.equal(PAGE_COOKIE, "voni_email_view");
});

test("isPageUnlocked only accepts the matching password", () => {
  const cookie = pagePasswordDigest(PASSWORD);

  assert.equal(isPageUnlocked(cookie, PASSWORD), true);
  assert.equal(isPageUnlocked(cookie, "wrong password"), false);
  assert.equal(isPageUnlocked(pagePasswordDigest("wrong password"), PASSWORD), false);
  // Malformed and truncated cookies are a plain false, not a throw.
  assert.equal(isPageUnlocked("not-a-digest", PASSWORD), false);
  assert.equal(isPageUnlocked("00".repeat(31), PASSWORD), false);
});

test("isPageUnlocked is false when either side is missing or empty", () => {
  assert.equal(isPageUnlocked(undefined, PASSWORD), false);
  assert.equal(isPageUnlocked("", PASSWORD), false);
  assert.equal(isPageUnlocked(pagePasswordDigest(PASSWORD), undefined), false);
  assert.equal(isPageUnlocked(pagePasswordDigest(PASSWORD), ""), false);
  assert.equal(isPageUnlocked(undefined, undefined), false);
});

test("a control-style digest does not open the page gate", () => {
  const controlStyle = createHash("sha256").update(PASSWORD, "utf8").digest("hex");
  assert.equal(isPageUnlocked(controlStyle, PASSWORD), false);
});

test("the gate cookie is httpOnly, lax, scoped to /email and short-lived", () => {
  const options = pageGateCookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/email");
  assert.equal(options.maxAge, 60 * 60 * 12);
  assert.equal(options.secure, process.env.NODE_ENV === "production");
});

test("the gate module does no I/O", () => {
  const source = readFileSync(join(here, "page-gate.ts"), "utf8");
  assert.doesNotMatch(source, /from "next\/headers"/);
  assert.doesNotMatch(source, /from "next\/server"/);
  assert.doesNotMatch(source, /await\s/);
});
