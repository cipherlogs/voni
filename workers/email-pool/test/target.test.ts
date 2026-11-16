import { test } from "node:test";
import assert from "node:assert/strict";

import { validateTarget } from "../src/target.ts";
import type { ValidationResult } from "../src/target.ts";

function expectReject(result: ValidationResult, reason: string): void {
  if (result.ok) assert.fail(`expected rejection (${reason}), got ${result.url}`);
  assert.equal(result.reason, reason);
  assert.ok(result.detail.length > 0);
}

function expectAccept(result: ValidationResult, expectedHost: string): URL {
  if (!result.ok) assert.fail(`expected accept, got ${result.reason}: ${result.detail}`);
  assert.equal(result.url.host, expectedHost);
  return result.url;
}

test("accepts any https host, listed or not", () => {
  expectAccept(validateTarget("https://voni.cc/test"), "voni.cc");
  expectAccept(validateTarget("https://evil.example/test"), "evil.example");
  expectAccept(validateTarget("https://someone-elses-blog.dev/post"), "someone-elses-blog.dev");
});

test("accepts lookalikes and unusual ports: there is no host policy", () => {
  expectAccept(validateTarget("https://voni.cc.evil.example/"), "voni.cc.evil.example");
  expectAccept(validateTarget("https://evil.github.io/print/"), "evil.github.io");
  expectAccept(validateTarget("https://voni.cc:8443/"), "voni.cc:8443");
});

test("accepts http on any host", () => {
  expectAccept(validateTarget("http://voni.cc/test"), "voni.cc");
  expectAccept(validateTarget("http://localhost:3000/email"), "localhost:3000");
  expectAccept(validateTarget("http://127.0.0.1:3000/email"), "127.0.0.1:3000");
});

test("accepts loopback and private IP literals", () => {
  for (const host of [
    "10.0.0.5:3000",
    "192.168.1.10:3000",
    "172.20.0.1:3000",
    "169.254.1.1:3000",
    "100.64.0.1:3000",
  ]) {
    expectAccept(validateTarget(`https://${host}/`), host);
  }
  expectAccept(validateTarget("https://[::1]:3000/"), "[::1]:3000");
});

test("accepts URLs with query strings and fragments intact", () => {
  const url = expectAccept(
    validateTarget("https://voni.cc/test?utm_source=gmail.com#top"),
    "voni.cc",
  );
  assert.equal(url.pathname, "/test");
  assert.equal(url.searchParams.get("utm_source"), "gmail.com");
  assert.equal(url.hash, "#top");
});

test("normalizes host case", () => {
  expectAccept(validateTarget("https://WWW.VONI.CC/"), "www.voni.cc");
});

test("rejects non-http(s) protocols by name", () => {
  expectReject(validateTarget("ftp://voni.cc/test"), "unsupported_protocol");
  expectReject(validateTarget("javascript:alert(1)"), "unsupported_protocol");
  expectReject(validateTarget("file:///etc/passwd"), "unsupported_protocol");
});

test("rejects unparseable and empty input", () => {
  expectReject(validateTarget("not a url"), "invalid_url");
  expectReject(validateTarget("/print/"), "invalid_url");
  expectReject(validateTarget(""), "invalid_url");
  expectReject(validateTarget("   "), "invalid_url");
  expectReject(validateTarget(undefined), "invalid_url");
  expectReject(validateTarget(null), "invalid_url");
  expectReject(validateTarget({ url: "https://voni.cc" }), "invalid_url");
});

test("rejects embedded credentials", () => {
  expectReject(validateTarget("https://user:pass@voni.cc/test"), "credentials");
  expectReject(validateTarget("https://user@voni.cc/test"), "credentials");
});
