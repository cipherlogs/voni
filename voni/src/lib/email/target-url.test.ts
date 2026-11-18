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
  canonicalTargetUrl,
  isPrivateIpLiteral,
  normaliseHostname,
  targetHost,
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
    assert.match(String(targetUrlProblem(entry)), /IP address/, entry);
    assert.throws(() => assertEmailTargetUrl(entry), /Invalid click target/);
  }
});

test("every IP literal is refused, private or not: the target is a site", () => {
  // The panel takes the URL a click opens, and that is a domain. Refusing all
  // literals is also stricter than refusing ranges, so a pasted address cannot
  // become a host the redirect guard would later accept.
  assert.equal(isPrivateIpLiteral("93.184.216.34"), false);
  assert.match(
    String(targetUrlProblem("https://93.184.216.34/")),
    /IP address/,
  );
  assert.match(
    String(targetUrlProblem("https://[2606:4700::1111]/")),
    /IP address/,
  );
});

test("the canonical form makes one target out of a paste's spelling", () => {
  // `https://x.com` and `https://x.com/` were two rows competing in the bag.
  assert.equal(canonicalTargetUrl("https://x.com"), "https://x.com/");
  assert.equal(canonicalTargetUrl(" https://X.COM:443/a "), "https://x.com/a");
  assert.equal(
    canonicalTargetUrl("https://www.glizzitrium.com/BCMPW39K/946KZGB/?creative_id=710986&utm_source=gmail.com"),
    "https://www.glizzitrium.com/BCMPW39K/946KZGB/?creative_id=710986&utm_source=gmail.com",
  );
  // Query order is preserved, not sorted: the same URL twice is the same row.
  assert.equal(
    canonicalTargetUrl("https://x.com/?b=2&a=1"),
    canonicalTargetUrl("https://x.com/?b=2&a=1"),
  );
});

test("the shared host helper is what the panel row shows", () => {
  assert.equal(targetHost("https://www.example.com:443/a"), "www.example.com");
  assert.equal(targetHost("not a url"), "not a url");
});

test("the root-dot host form is normalised, a double dot is not", () => {
  assert.equal(normaliseHostname("WWW.Example.COM."), "www.example.com");
  assert.equal(normaliseHostname("example.com.."), "example.com.");
});

test("a URL past the report's own bound is refused, not truncated", () => {
  const tooLong = `https://example.com/${"a".repeat(TARGET_URL_MAX_LENGTH)}`;
  assert.match(String(targetUrlProblem(tooLong)), /longer than/);
});
