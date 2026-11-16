import { test } from "node:test";
import assert from "node:assert/strict";

import { validateTarget } from "../src/target.ts";
import type { ValidationResult } from "../src/target.ts";

const PROD = {
  allowedHosts: ["voni.cc", "www.voni.cc", "cipherlogs.github.io"],
  allowPrivate: false,
};

const DEV = {
  allowedHosts: [
    "voni.cc",
    "www.voni.cc",
    "localhost:3000",
    "127.0.0.1:3000",
    "cipherlogs.github.io",
  ],
  allowPrivate: true,
};

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

test("rejects a foreign host", () => {
  expectReject(validateTarget("https://evil.example/test", PROD), "host_not_allowed");
});

test("rejects a lookalike host", () => {
  expectReject(validateTarget("https://voni.cc.evil.example/", PROD), "host_not_allowed");
});

test("rejects the right host on the wrong port", () => {
  expectReject(validateTarget("https://voni.cc:8443/", PROD), "host_not_allowed");
});

test("rejects http on a production host", () => {
  expectReject(validateTarget("http://voni.cc/test", PROD), "insecure_protocol");
});

test("rejects embedded credentials", () => {
  expectReject(validateTarget("https://user:pass@voni.cc/test", PROD), "credentials");
  expectReject(validateTarget("https://user@voni.cc/test", PROD), "credentials");
});

test("rejects non-http(s) protocols", () => {
  expectReject(validateTarget("ftp://voni.cc/test", PROD), "unsupported_protocol");
  expectReject(validateTarget("javascript:alert(1)", PROD), "unsupported_protocol");
});

test("rejects unparseable and empty input", () => {
  expectReject(validateTarget("not a url", PROD), "invalid_url");
  expectReject(validateTarget("", PROD), "invalid_url");
  expectReject(validateTarget(undefined, PROD), "invalid_url");
  expectReject(validateTarget({ url: "https://voni.cc" }, PROD), "invalid_url");
});

test("accepts https voni.cc with query string", () => {
  const url = expectAccept(
    validateTarget("https://voni.cc/test?utm_source=gmail.com", PROD),
    "voni.cc",
  );
  assert.equal(url.pathname, "/test");
  assert.equal(url.searchParams.get("utm_source"), "gmail.com");
});

test("accepts www.voni.cc and normalizes host case", () => {
  expectAccept(validateTarget("https://WWW.VONI.CC/", PROD), "www.voni.cc");
});

test("accepts the GitHub Pages print page", () => {
  const url = expectAccept(
    validateTarget("https://cipherlogs.github.io/print/", PROD),
    "cipherlogs.github.io",
  );
  assert.equal(url.pathname, "/print/");
});

test("rejects github.io lookalikes: the match is the exact host, not a suffix", () => {
  expectReject(
    validateTarget("https://evil.github.io/print/", PROD),
    "host_not_allowed",
  );
  expectReject(
    validateTarget("https://cipherlogs.github.io.evil.test/", PROD),
    "host_not_allowed",
  );
});

test("accepts localhost:3000 only when the dev allowlist and allowPrivate agree", () => {
  expectAccept(validateTarget("http://localhost:3000/email", DEV), "localhost:3000");
  expectAccept(validateTarget("http://127.0.0.1:3000/", DEV), "127.0.0.1:3000");
});

test("rejects localhost:3000 without allowPrivate", () => {
  expectReject(
    validateTarget("http://localhost:3000/", {
      allowedHosts: ["localhost:3000"],
      allowPrivate: false,
    }),
    "private_target",
  );
});

test("rejects private IP literals unless allowPrivate", () => {
  const allowlisted = {
    allowedHosts: ["10.0.0.5:3000"],
  };
  expectReject(validateTarget("https://10.0.0.5:3000/", allowlisted), "private_target");
  expectAccept(
    validateTarget("https://10.0.0.5:3000/", { ...allowlisted, allowPrivate: true }),
    "10.0.0.5:3000",
  );
});

test("private range detection covers RFC1918, link-local, and CGNAT", () => {
  for (const host of ["192.168.1.10:3000", "172.20.0.1:3000", "169.254.1.1:3000", "100.64.0.1:3000"]) {
    expectReject(
      validateTarget(`https://${host}/`, { allowedHosts: [host] }),
      "private_target",
    );
  }
});

test("rejects loopback IPv6 literal without allowPrivate", () => {
  expectReject(
    validateTarget("https://[::1]:3000/", { allowedHosts: ["[::1]:3000"] }),
    "private_target",
  );
});

test("does not allow a dev host on a non-allowlisted port", () => {
  expectReject(validateTarget("http://localhost:4000/", DEV), "insecure_protocol");
  expectReject(validateTarget("https://localhost:4000/", DEV), "host_not_allowed");
});
