import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OUTPUT_SAMPLE_RATE,
  OutputFormatError,
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
