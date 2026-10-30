import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAKE_SAMPLE_RATE,
  loadScriptedService,
  recordedCall,
  replyAudioSeconds,
  replyToneHz,
  uniqueAudioSeconds,
} from "../tests/e2e/cascade-fake-server";

/**
 * The browser E2E's service half is a committed script (ticket 149, extended by
 * ticket 150, pointed at the landing demo by ticket 16). These checks run in
 * the PR unit gate, so a broken or empty fixture fails before the slower
 * browser job ever starts. The script must carry the behaviours the browser
 * seam asserts: a greeting caption, numbered audio, a barge-in, the pipeline's
 * tagged invite line, a replayed frame and a goodbye.
 */

test("the scripted service is a full demo call: greeting, barge-in, invite, end_call", () => {
  const document = loadScriptedService();
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.sampleRate, FAKE_SAMPLE_RATE);
  assert.ok(document.testTag, "the fixture names the call's Test tag");
  const frames = recordedCall();
  const types = frames.map((entry) => entry.frame.type);
  const captions = frames.filter((entry) => entry.frame.type === "caption");
  assert.equal(captions.length, 4, "greeting, barge-in, next reply and the invite line");
  assert.ok(types.includes("audio"), "the capture has agent audio to deliver");
  assert.equal(types.filter((type) => type === "interrupted").length, 1, "one barge-in");
  assert.ok(document.interruptAfterMs > 0, "the barge-in lands after audio has been queued");
  assert.equal(types.at(-1), "end_call", "the call ends with the goodbye drain");
  assert.ok(
    captions.every((entry) => entry.frame.final === true),
    "the transcript settles on a final",
  );
  const greeting = captions.find((entry) => entry.frame.role === "agent");
  assert.ok(greeting, "the call opens with Voni's greeting caption");
  const invite = frames.find((entry) => entry.tool === "show_test_address");
  assert.ok(invite, "the pipeline's server-side invite is in the script");
  assert.equal(invite!.frame.role, "agent");
  assert.ok(
    String(invite!.frame.text).includes(document.testTag!),
    "the invite line carries the call's Test tag",
  );
});

test("every audio frame stamps the rate and the call-level seq the client needs", () => {
  const seen = new Set<number>();
  for (const [index, entry] of recordedCall().entries()) {
    if (entry.frame.type !== "audio") continue;
    assert.equal(entry.frame.sample_rate, FAKE_SAMPLE_RATE, `frame ${index}`);
    const seq = entry.frame.seq;
    assert.equal(typeof seq, "number", `frame ${index} has a call-level seq`);
    assert.ok(Number.isInteger(seq) && (seq as number) > 0, `frame ${index} seq is monotonic`);
    // A replay repeats a seq on purpose; every other frame advances the call.
    if (!entry.duplicate) {
      assert.equal(seen.has(seq as number), false, `frame ${index} seq ${seq} is unique`);
      seen.add(seq as number);
    }
    assert.equal(typeof entry.frame.data, "string");
    const bytes = Buffer.from(String(entry.frame.data), "base64").length;
    assert.ok(bytes > 0 && bytes % 2 === 0, `frame ${index} is whole PCM16 samples`);
  }
});

test("the script is two differently-pitched replies, so the capture can tell them apart", () => {
  const greeting = replyToneHz("greeting");
  const second = replyToneHz("second");
  assert.notEqual(greeting, second, "one tone could not prove which reply was cut");
  assert.ok(replyAudioSeconds("greeting") > 1, "the interrupted greeting is long enough to cut");
  assert.ok(replyAudioSeconds("second") > 0.5, "the goodbye drains through the worklet");
});

test("duplicates are labelled and excluded from the unique duration", () => {
  const document = loadScriptedService();
  const duplicates = recordedCall().filter((entry) => entry.duplicate);
  assert.ok(duplicates.length >= 2, "the script replays at least two frames");
  for (const entry of duplicates) {
    assert.equal(entry.frame.type, "audio");
    const original = recordedCall().find(
      (candidate) =>
        candidate.frame.type === "audio" &&
        !candidate.duplicate &&
        candidate.frame.seq === entry.frame.seq,
    );
    assert.ok(original, "a replay repeats a seq the call already sent");
    assert.equal(original!.frame.data, entry.frame.data, "with the same bytes");
  }
  assert.ok(Math.abs(uniqueAudioSeconds() - document.audioSeconds) < 1e-9);
  assert.ok(uniqueAudioSeconds() >= 1, "a capture shorter than a second would prove little");
});

test("the replay is deterministic: same bytes on every load", () => {
  const first = JSON.stringify(recordedCall());
  const second = JSON.stringify(recordedCall());
  assert.equal(first, second);
});
