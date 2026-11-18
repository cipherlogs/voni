/**
 * The one rule an added target must satisfy. Proved here because the panel's
 * form is a public endpoint once it is a server action: `type="url"` in the
 * browser is a convenience, and the server re-runs this module.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGET_URL_MAX_LENGTH,
  assertEmailTargetUrl,
  isPrivateIpLiteral,
  normaliseHostname,
  targetUrlProblem,
} from "./target-url";

const OK = [
  "https://www.glizzitrium.com/BCMPW39K/946KZGB/?creative_id=710986",
  "https://voni.cc/test",
  "https://cipherlogs.github.io/print/",
  "https://example.com:443/path?q=1",
];

test("an https URL on the default port with a public host is accepted", () => {
  for (const url of OK) {
    assert.equal(targetUrlProblem(url), null, url);
    assert.equal(assertEmailTargetUrl(url), url);
  }
});

test("plaintext, a custom port, credentials and single-label hosts are refused", () => {
  const cases = [
    ["http://example.com/", /https/],
    ["https://example.com:8443/", /port/],
    ["https://user:pass@example.com/", /username or password/],
    ["https://localhost/", /public domain/],
    ["https://intranet/", /public domain/],
    ["ftp://example.com/", /https/],
    ["", /empty/],
    ["not a url", /absolute URL|whitespace/],
  ] as const;

  for (const [entry, expected] of cases) {
    const problem = targetUrlProblem(entry);
    assert.ok(problem !== null, `${entry} must be refused`);
    assert.match(problem, expected, `${entry} -> ${problem}`);
  }
});

test("a private address is refused as a host, in either literal form", () => {
  for (const entry of [
    "https://127.0.0.1/",
    "https://10.1.2.3/",
    "https://169.254.169.254/latest/meta-data/",
    "https://192.168.0.1/",
    "https://100.64.0.1/",
    "https://[::1]/",
    "https://[fd00::1]/",
  ]) {
    assert.match(String(targetUrlProblem(entry)), /private|non-public/, entry);
    assert.throws(() => assertEmailTargetUrl(entry), /Invalid click target/);
  }
});

test("a public literal is still a literal, but not a private one", () => {
  // Not encouraged, but not an SSRF: the rule refuses ranges, not syntax.
  assert.equal(isPrivateIpLiteral("93.184.216.34"), false);
  assert.equal(targetUrlProblem("https://93.184.216.34/"), null);
});

test("the root-dot host form is normalised, a double dot is not", () => {
  assert.equal(normaliseHostname("WWW.Example.COM."), "www.example.com");
  assert.equal(normaliseHostname("example.com.."), "example.com.");
});

test("a URL past the report's own bound is refused, not truncated", () => {
  const tooLong = `https://example.com/${"a".repeat(TARGET_URL_MAX_LENGTH)}`;
  assert.match(String(targetUrlProblem(tooLong)), /longer than/);
});
