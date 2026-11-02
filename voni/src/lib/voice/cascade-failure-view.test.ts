import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMO_UNAVAILABLE_MESSAGES,
  demoReconnectFailedMessage,
  demoUnavailableMessage,
} from "./cascade-failure-view";

/**
 * The demo has no managed fallback (demo-cascade ticket 11). Every pre-accept
 * refusal — draining, routed managed, unavailable, protocol mismatch — ends in
 * a visitor-facing unavailable state. These are the words the visitor reads,
 * so they must be distinct, human, and never name an engine, a route or a
 * vendor.
 */
test("every demo refusal cause has a distinct, vendor-free visitor message", () => {
  const causes = ["draining", "managed", "unavailable", "protocol"] as const;
  const messages = causes.map((cause) => demoUnavailableMessage(cause));

  assert.deepEqual(
    Object.keys(DEMO_UNAVAILABLE_MESSAGES).sort(),
    [...causes].sort(),
    "one message per refusal cause",
  );
  assert.equal(new Set(messages).size, causes.length, "each cause reads differently");
  for (const message of messages) {
    assert.ok(message.trim().length > 20, `a real sentence, got ${JSON.stringify(message)}`);
    assert.doesNotMatch(message, /managed|engine|vendor|routing|cascade|assemblyai|meta/i);
    assert.match(message, /demo|call|try again|reload/i, "the visitor is told what to do");
  }
});

test("a dropped live call has its own honest line per named cause", () => {
  const causes = [
    "second-drop",
    "timeout",
    "mint-failed",
    "socket-error",
    "socket-closed",
    "refused:draining",
  ];
  const messages = causes.map((cause) => demoReconnectFailedMessage(cause));

  for (const message of messages) {
    assert.ok(message.trim().length > 20, `a real sentence, got ${JSON.stringify(message)}`);
    assert.doesNotMatch(message, /managed|engine|vendor|routing|cascade|assemblyai|meta/i);
    assert.match(message, /call|connection|try again|new call/i, "the visitor is told what to do");
    assert.equal(message, message.trim());
    assert.doesNotMatch(message, /\n/);
  }
  assert.notEqual(
    demoReconnectFailedMessage("second-drop"),
    demoReconnectFailedMessage("timeout"),
    "a second drop reads differently from a resume that timed out",
  );
});

test("the unavailable line stays one sentence the UI can render as an alert", () => {
  for (const cause of ["draining", "managed", "unavailable", "protocol"] as const) {
    const message = demoUnavailableMessage(cause);
    assert.equal(message, message.trim(), "no surrounding whitespace");
    assert.doesNotMatch(message, /\n/, "one paragraph");
  }
});
