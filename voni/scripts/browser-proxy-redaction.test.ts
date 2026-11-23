import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { redactProxyText } from "./browser-proxy-redaction.mjs";

/**
 * A launch failure is the one place the proxy reaches a human: Playwright can
 * quote the launch options, and `readProxy` accepts `user:pass@` inline. These
 * tests hold two lines — the credentials never appear in the sentence, and the
 * sentence still fails the run.
 */

const RUNNER = readFileSync(
  new URL("./browser-click.mjs", import.meta.url),
  "utf8",
);

const PROXY = {
  server: "http://runner:hunter2@proxy.example.com:8080",
  username: "runner",
  password: "hunter2",
};

test("an inline user:pass@ in a quoted URL never survives redaction", () => {
  const text = [
    'browser: <launch> args: proxy={"server":"http://runner:hunter2@proxy.example.com:8080"}',
    "target https://runner:hunter2@other.example.com/path answered 502",
  ].join("\n");
  const redacted = redactProxyText(text, PROXY);

  assert.doesNotMatch(redacted, /runner:hunter2@/, "no user:pass@ remains");
  assert.doesNotMatch(redacted, /hunter2/, "no password remains anywhere");
  assert.match(redacted, /\[redacted\]@proxy\.example\.com:8080/, "the host stays named");
  assert.match(redacted, /answered 502/, "the cause is still readable");
});

test("a bare proxy password is redacted, and no proxy leaves the URL rule", () => {
  assert.doesNotMatch(
    redactProxyText("net::ERR_PROXY_CONNECTION_FAILED password=hunter2", PROXY),
    /hunter2/,
  );
  assert.doesNotMatch(
    redactProxyText("connect via http://runner:hunter2@proxy.example.com"), /hunter2/,
  );
  assert.equal(redactProxyText("plain failure", undefined), "plain failure");
});

test("the launch failure is printed redacted and still exits non-zero", () => {
  const start = RUNNER.indexOf("could not launch real Chrome");
  assert.notEqual(start, -1, "the launch failure is reported");
  const sentence = RUNNER.slice(start - 300, start + 300);
  assert.match(
    sentence,
    /redactProxyText\(message, config\.proxy\)/,
    "the message passes through the redaction before `stop`",
  );

  const stop = RUNNER.slice(RUNNER.indexOf("function stop("), RUNNER.indexOf("function readEnv("));
  assert.match(stop, /process\.exit\(2\)/, "a launch failure is a failing run");
});
