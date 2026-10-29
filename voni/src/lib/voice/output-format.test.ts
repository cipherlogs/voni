import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OUTPUT_ENCODING,
  DEFAULT_OUTPUT_SAMPLE_RATE,
  OutputFormatError,
  decodeOutputAudio,
  resolveOutputEncoding,
  resolveOutputFormat,
  resolveOutputSampleRate,
} from "./output-format";

test("the confirmation's resolved rate is the playback rate", () => {
  assert.equal(
    resolveOutputSampleRate({ output: { format: { sample_rate: 16000 } } }),
    16000,
  );
  assert.equal(
    resolveOutputSampleRate({ output: { format: { sample_rate: 48000 } } }),
    48000,
  );
});

test("a confirmation with no rate falls back to the named default", () => {
  // Pinned: the API's native output is 24 kHz PCM16. The constant is the
  // named fallback, never the source when the server tells us otherwise.
  assert.equal(DEFAULT_OUTPUT_SAMPLE_RATE, 24_000);
  assert.equal(resolveOutputSampleRate({}), DEFAULT_OUTPUT_SAMPLE_RATE);
  assert.equal(
    resolveOutputSampleRate({ output: { format: { encoding: "audio/pcm" } } }),
    DEFAULT_OUTPUT_SAMPLE_RATE,
  );
  assert.equal(resolveOutputSampleRate(undefined), DEFAULT_OUTPUT_SAMPLE_RATE);
});

test("a rate the client cannot play is refused, never guessed", () => {
  for (const sample_rate of [0, -16000, 16000.5, "16000", Number.NaN]) {
    assert.throws(
      () => resolveOutputSampleRate({ output: { format: { sample_rate } } }),
      (error: unknown) =>
        error instanceof OutputFormatError &&
        /sample rate/i.test(error.message),
      `accepted ${JSON.stringify(sample_rate)}`,
    );
  }
});

test("the confirmation's resolved encoding is the playback encoding", () => {
  // The Agent API's three output encodings: PCM16, G.711 mu-law and A-law.
  for (const encoding of ["audio/pcm", "audio/pcmu", "audio/pcma"]) {
    assert.equal(
      resolveOutputEncoding({ output: { format: { encoding } } }),
      encoding,
    );
  }
  // No encoding echoes the API's documented default, never a guess.
  assert.equal(DEFAULT_OUTPUT_ENCODING, "audio/pcm");
  assert.equal(resolveOutputEncoding({}), DEFAULT_OUTPUT_ENCODING);
  assert.equal(
    resolveOutputEncoding({ output: { format: { encoding: null } } }),
    DEFAULT_OUTPUT_ENCODING,
  );
});

test("an encoding the client cannot play is refused, naming the encoding", () => {
  for (const encoding of ["audio/opus", "audio/mp3", "pcm_s16le", "", 42]) {
    assert.throws(
      () => resolveOutputEncoding({ output: { format: { encoding } } }),
      (error: unknown) =>
        error instanceof OutputFormatError &&
        /output encoding/i.test(error.message) &&
        error.message.includes(String(encoding)),
      `accepted ${JSON.stringify(encoding)}`,
    );
  }
});

test("the resolved format pairs each encoding with its rate", () => {
  // G.711 is an 8 kHz telephony encoding. Echoing the encoding without a rate
  // must not leave the client playing 8 kHz samples at the 24 kHz default.
  assert.deepEqual(resolveOutputFormat({ output: { format: { encoding: "audio/pcmu" } } }), {
    encoding: "audio/pcmu",
    sampleRate: 8_000,
  });
  assert.deepEqual(resolveOutputFormat({ output: { format: { encoding: "audio/pcma" } } }), {
    encoding: "audio/pcma",
    sampleRate: 8_000,
  });
  assert.deepEqual(
    resolveOutputFormat({
      output: { format: { encoding: "audio/pcmu", sample_rate: 16_000 } },
    }),
    // An explicitly resolved rate always wins; the encoding only supplies the
    // fallback when the confirmation carries none.
    { encoding: "audio/pcmu", sampleRate: 16_000 },
  );
});

test("an unsupported encoding is refused by the combined resolver too", () => {
  assert.throws(
    () => resolveOutputFormat({ output: { format: { encoding: "audio/opus" } } }),
    (error: unknown) =>
      error instanceof OutputFormatError && /output encoding/i.test(error.message),
  );
});

/** Decode little-endian PCM16 back to samples for a readable assertion. */
function samples(pcm: Uint8Array): number[] {
  assert.equal(pcm.length % 2, 0);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  return Array.from({ length: pcm.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

test("a PCM16 chunk passes through byte for byte", () => {
  const bytes = Uint8Array.from([0x01, 0x02, 0xff, 0x7f]);
  assert.deepEqual(decodeOutputAudio(bytes, "audio/pcm"), bytes);
});

test("mu-law bytes decode to the documented 16-bit levels", () => {
  // Known-good G.711 mu-law table values, independent of this decoder.
  // 0xFF is silence; 0x00/0x80 are the full-scale negative/positive codes.
  const decoded = decodeOutputAudio(
    Uint8Array.from([0xff, 0x00, 0x80, 0x7f]),
    "audio/pcmu",
  );
  assert.deepEqual(samples(decoded), [0, -32124, 32124, 0]);
});

test("A-law bytes decode to the documented 16-bit levels", () => {
  // Known-good G.711 A-law table values: 0xD5 is silence (the codec's +8
  // quantisation offset), 0x2A/0xAA are full-scale negative/positive.
  const decoded = decodeOutputAudio(
    Uint8Array.from([0xd5, 0x2a, 0xaa, 0x55]),
    "audio/pcma",
  );
  assert.deepEqual(samples(decoded), [8, -32256, 32256, -8]);
});

test("G.711 silence is silence, never corruption", () => {
  // A fully silent chunk is a valid stream, not a decode failure: it must
  // decode (and later play) as silence rather than being refused.
  assert.deepEqual(samples(decodeOutputAudio(new Uint8Array(160).fill(0xff), "audio/pcmu")), new Array(160).fill(0));
  const alaw = samples(decodeOutputAudio(new Uint8Array(160).fill(0xd5), "audio/pcma"));
  assert.ok(alaw.every((sample) => Math.abs(sample) <= 8));
});

test("an empty chunk is silence, never a failure", () => {
  for (const encoding of ["audio/pcm", "audio/pcmu", "audio/pcma"] as const) {
    assert.equal(decodeOutputAudio(new Uint8Array(), encoding).length, 0);
  }
});

test("a malformed PCM16 chunk is refused, never padded into silence", () => {
  // Three bytes cannot be whole 16-bit samples. Dropping or zero-padding the
  // tail would play corruption as if it were silence.
  for (const bytes of [Uint8Array.from([1, 2, 3]), Uint8Array.from([1])]) {
    assert.throws(
      () => decodeOutputAudio(bytes, "audio/pcm"),
      (error: unknown) =>
        error instanceof OutputFormatError && /malformed/i.test(error.message),
    );
  }
});
