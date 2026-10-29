/**
 * Format facts are the foundation of the three-way audio comparison: every
 * later metric assumes the file it measures reports the rate, channel count
 * and duration it actually contains.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioFactsError, decodeAudioFile, decodePcm, decodeWav } from "./format-facts";
type WavOptions = {
  sampleRate: number;
  channels: number;
  frameCount: number;
  sampleAt?: (frame: number, channel: number) => number;
  /** Extra chunk inserted before `data`, to prove the parser walks chunks. */
  extraChunk?: { id: string; body: Buffer };
};

/** A minimal s16le WAV written independently of the parser under test. */
export function wavBytes({
  sampleRate,
  channels,
  frameCount,
  sampleAt = () => 0,
  extraChunk,
}: WavOptions): Buffer {
  const blockAlign = channels * 2;
  const dataBytes = frameCount * blockAlign;
  const extraBytes = extraChunk ? 8 + extraChunk.body.length + (extraChunk.body.length % 2) : 0;
  const out = Buffer.alloc(44 + extraBytes + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + extraBytes + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * blockAlign, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(16, 34);
  let offset = 36;
  if (extraChunk) {
    out.write(extraChunk.id, offset);
    out.writeUInt32LE(extraChunk.body.length, offset + 4);
    extraChunk.body.copy(out, offset + 8);
    offset += 8 + extraChunk.body.length + (extraChunk.body.length % 2);
  }
  out.write("data", offset);
  out.writeUInt32LE(dataBytes, offset + 4);
  offset += 8;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      out.writeInt16LE(sampleAt(frame, channel), offset + (frame * channels + channel) * 2);
    }
  }
  return out;
}

test("a mono 24 kHz WAV reports its true rate, channels, duration and byte rate", () => {
  const bytes = wavBytes({
    sampleRate: 24_000,
    channels: 1,
    frameCount: 24_000,
    sampleAt: (frame) => (frame === 0 ? 1000 : frame === 23_999 ? -1000 : 0),
  });

  const { facts, samples } = decodeWav(bytes);

  assert.equal(facts.sampleRate, 24_000);
  assert.equal(facts.channels, 1);
  assert.equal(facts.bitsPerSample, 16);
  assert.equal(facts.container, "wav");
  assert.equal(facts.frameCount, 24_000);
  assert.equal(facts.dataBytes, 48_000);
  assert.equal(facts.byteRate, 48_000);
  assert.equal(facts.durationSeconds, 1);
  assert.equal(samples.length, 24_000);
  assert.equal(samples[0], 1000);
  assert.equal(samples[23_999], -1000);
});

test("a stereo 44.1 kHz WAV reports two channels and interleaves them", () => {
  const bytes = wavBytes({
    sampleRate: 44_100,
    channels: 2,
    frameCount: 11_025,
    sampleAt: (frame, channel) => (channel === 0 ? 1234 : -1234),
  });

  const { facts, samples } = decodeWav(bytes);

  assert.equal(facts.sampleRate, 44_100);
  assert.equal(facts.channels, 2);
  assert.equal(facts.frameCount, 11_025);
  assert.equal(facts.dataBytes, 44_100);
  assert.equal(facts.byteRate, 176_400);
  assert.equal(facts.durationSeconds, 0.25);
  assert.equal(samples.length, 22_050);
  assert.deepEqual([samples[0], samples[1], samples[2], samples[3]], [1234, -1234, 1234, -1234]);
});

test("chunks before the sample data do not shift the facts", () => {
  const bytes = wavBytes({
    sampleRate: 16_000,
    channels: 1,
    frameCount: 8000,
    extraChunk: { id: "LIST", body: Buffer.from("INFOISFT\x05\x00\x00\x00test\x00") },
  });

  const { facts } = decodeWav(bytes);

  assert.equal(facts.sampleRate, 16_000);
  assert.equal(facts.frameCount, 8000);
  assert.equal(facts.durationSeconds, 0.5);
});

/** Copy a WAV and rewrite a header field, to build a malformed neighbour. */
function patchedWav(bytes: Buffer, patch: (copy: Buffer) => void): Buffer {
  const copy = Buffer.from(bytes);
  patch(copy);
  return copy;
}

test("a headerless file is refused by name, never guessed from its length", () => {
  const headerless = Buffer.from("this is a recording with no RIFF header at all");

  assert.throws(
    () => decodeWav(headerless),
    (error: unknown) =>
      error instanceof AudioFactsError &&
      error.name === "AudioFactsError" &&
      error.code === "not-wav",
  );
});

test("a truncated file is refused by name, never trimmed to a shorter duration", () => {
  const full = wavBytes({ sampleRate: 24_000, channels: 1, frameCount: 24_000 });
  // Cut inside the declared data chunk while leaving the RIFF size honest.
  const cut = full.subarray(0, 44 + 100);

  assert.throws(
    () => decodeWav(cut),
    (error: unknown) => error instanceof AudioFactsError && error.code === "truncated",
  );

  // Same short file with a patched RIFF size: the data chunk must still be
  // caught rather than believed.
  const patched = patchedWav(cut, (copy) => copy.writeUInt32LE(copy.length - 8, 4));
  assert.throws(
    () => decodeWav(patched),
    (error: unknown) => error instanceof AudioFactsError && error.code === "truncated",
  );
});

test("a sample format the analyser cannot read is refused, not reinterpreted", () => {
  const wav = wavBytes({ sampleRate: 24_000, channels: 1, frameCount: 24 });

  assert.throws(
    () => decodeWav(patchedWav(wav, (copy) => copy.writeUInt16LE(24, 34))),
    (error: unknown) => error instanceof AudioFactsError && error.code === "unsupported-format",
  );
  assert.throws(
    () => decodeWav(patchedWav(wav, (copy) => copy.writeUInt16LE(3, 20))),
    (error: unknown) =>
      error instanceof AudioFactsError &&
      error.code === "unsupported-format" &&
      /encoding 3/.test(error.message),
  );
});

test("a header whose byte rate disagrees with its rate is refused", () => {
  const wav = wavBytes({ sampleRate: 24_000, channels: 1, frameCount: 24 });

  assert.throws(
    () => decodeWav(patchedWav(wav, (copy) => copy.writeUInt32LE(24_000, 28))),
    (error: unknown) => error instanceof AudioFactsError && error.code === "invalid-format",
  );
});

test("raw PCM reports the same facts as its WAV twin when given its format", () => {
  const frameCount = 24_000;
  const pcm = Buffer.alloc(frameCount * 2 * 2);
  for (let frame = 0; frame < frameCount; frame++) {
    pcm.writeInt16LE(frame % 32768, frame * 4);
    pcm.writeInt16LE(-(frame % 32768), frame * 4 + 2);
  }

  const { facts, samples } = decodePcm(pcm, { sampleRate: 48_000, channels: 2 });

  assert.equal(facts.container, "pcm");
  assert.equal(facts.sampleRate, 48_000);
  assert.equal(facts.channels, 2);
  assert.equal(facts.frameCount, 24_000);
  assert.equal(facts.dataBytes, 96_000);
  assert.equal(facts.byteRate, 192_000);
  assert.equal(facts.durationSeconds, 0.5);
  assert.deepEqual([samples[0], samples[1], samples[2], samples[3]], [0, 0, 1, -1]);
});

test("raw PCM that ends mid-frame is refused rather than padded", () => {
  assert.throws(
    () => decodePcm(Buffer.alloc(101), { sampleRate: 24_000, channels: 2 }),
    (error: unknown) => error instanceof AudioFactsError && error.code === "truncated",
  );
});

test("raw PCM without an explicit format is refused, never guessed from the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "voni-audio-facts-"));
  const path = join(dir, "capture.pcm");
  try {
    writeFileSync(path, Buffer.alloc(96_000));
    assert.throws(
      () => decodeAudioFile(path),
      (error: unknown) => error instanceof AudioFactsError && error.code === "not-wav",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved WAV is analysed from disk with no browser, network or database", () => {
  const dir = mkdtempSync(join(tmpdir(), "voni-audio-facts-"));
  const path = join(dir, "delivered.wav");
  try {
    writeFileSync(
      path,
      wavBytes({ sampleRate: 24_000, channels: 1, frameCount: 12_000 }),
    );

    const { facts } = decodeAudioFile(path);

    assert.equal(facts.sampleRate, 24_000);
    assert.equal(facts.channels, 1);
    assert.equal(facts.frameCount, 12_000);
    assert.equal(facts.byteRate, 48_000);
    assert.equal(facts.durationSeconds, 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved raw PCM file is analysed when its format is supplied", () => {
  const dir = mkdtempSync(join(tmpdir(), "voni-audio-facts-"));
  const path = join(dir, "agent-channel.pcm");
  try {
    writeFileSync(path, Buffer.alloc(24_000 * 2));

    const { facts } = decodeAudioFile(path, { pcm: { sampleRate: 24_000, channels: 1 } });

    assert.equal(facts.container, "pcm");
    assert.equal(facts.sampleRate, 24_000);
    assert.equal(facts.frameCount, 24_000);
    assert.equal(facts.durationSeconds, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
