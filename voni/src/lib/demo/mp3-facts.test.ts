import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Mp3FactsError, mp3Facts } from "./mp3-facts";

/**
 * The audition clips are committed MP3s, so their bitrate has to be read from
 * the bytes a browser downloads — not from a note beside them. This parser is
 * the reader the clip test uses: a rate too low to survive a second encode is
 * a fact of the file, not of the manifest.
 */

const clip = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/voices/${name}.mp3`, import.meta.url)));

test("a committed clip reports the rate, bitrate and channels a preview actually plays", () => {
  const facts = mp3Facts(clip("anna"));
  assert.equal(facts.sampleRate, 24_000, "the preview is the session's native rate");
  assert.equal(facts.channels, 1, "the session is mono");
  assert.equal(facts.bitrateKbps, 160, "the clip is encoded at the surviving bitrate");
  assert.ok(facts.durationMs > 1_000, `a greeting is longer than a word (${facts.durationMs} ms)`);
  assert.ok(facts.durationMs < 8_000, `a greeting is a sentence (${facts.durationMs} ms)`);
  assert.ok(facts.frames > 0);
});

test("a file that is not an MPEG Layer III frame is refused, never guessed", () => {
  assert.throws(
    () => mp3Facts(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])),
    (error: unknown) => error instanceof Mp3FactsError && error.code === "not-mp3",
    "a WAV is not an MP3 by accident",
  );
});
