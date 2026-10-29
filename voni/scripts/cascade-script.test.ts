import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAKE_SAMPLE_RATE,
  loadScriptedService,
  queuedAudioSeconds,
  recordedCall,
} from "../tests/e2e/cascade-fake-server";

/**
 * The browser E2E's service half is a committed script (ticket 149). These
 * checks run in the PR unit gate, so a broken or empty fixture fails before
 * the slower browser job ever starts.
 */

test("the scripted service is a full cascade call: captions, audio, end_call", () => {
  const document = loadScriptedService();
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.sampleRate, 24_000);
  const frames = recordedCall();
  const types = frames.map((entry) => entry.frame.type);
  assert.deepEqual(types.filter((type) => type === "caption").length, 2);
  assert.ok(types.includes("audio"), "the capture has agent audio to deliver");
  assert.equal(types.at(-1), "end_call", "the call ends with the goodbye drain");
  assert.ok(
    frames.some((entry) => entry.frame.type === "caption" && entry.frame.final === true),
    "the transcript settles on a final",
  );
});

test("every audio frame stamps the rate the client plays at", () => {
  for (const [index, entry] of recordedCall().entries()) {
    if (entry.frame.type !== "audio") continue;
    assert.equal(entry.frame.sample_rate, FAKE_SAMPLE_RATE, `frame ${index}`);
    assert.equal(typeof entry.frame.data, "string");
    const bytes = Buffer.from(String(entry.frame.data), "base64").length;
    assert.ok(bytes > 0 && bytes % 2 === 0, `frame ${index} is whole PCM16 samples`);
  }
});

test("the queued duration is derived from the fixture bytes", () => {
  const seconds = queuedAudioSeconds();
  const document = loadScriptedService();
  assert.ok(Math.abs(seconds - document.audioSeconds) < 1e-9);
  assert.ok(seconds >= 1, "a capture shorter than a second would prove little");
});

test("the replay is deterministic: same bytes on every load", () => {
  const first = JSON.stringify(recordedCall());
  const second = JSON.stringify(recordedCall());
  assert.equal(first, second);
});
