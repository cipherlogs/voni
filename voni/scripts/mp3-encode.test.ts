import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyseLevel } from "../src/lib/audio/level-facts";
import { decodePcm } from "../src/lib/audio/format-facts";
import { mp3Facts } from "../src/lib/demo/mp3-facts";
import { pcm16Wav, REFERENCE_SAMPLE_RATE } from "../src/lib/demo/reference-render";
import {
  AUDITION_BITRATE_KBPS,
  AUDITION_CHANNELS,
  AUDITION_SAMPLE_RATE,
  decodeAuditionMp3,
  encodeAuditionMp3,
  hasFfmpeg,
} from "./lib/mp3-encode";

/**
 * The encoder is the last place a level could be baked in or a bitrate lost,
 * so it is tested on a synthetic native render rather than on a committed clip
 * that a previous run produced.
 */

const NATIVE_LUFS = -23;

/** A 3.5 s speech-shaped tone at a known level: 220 Hz + harmonics + a gap. */
function syntheticNativeWav(): Buffer {
  const frames = Math.round(3.5 * REFERENCE_SAMPLE_RATE);
  const pcm = Buffer.alloc(frames * 2 * AUDITION_CHANNELS);
  const amplitude = 10 ** (NATIVE_LUFS / 20) * 0.35; // rough: one tone is not speech
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / REFERENCE_SAMPLE_RATE;
    // A quiet half, so integrated loudness is not a single steady tone.
    const envelope = t > 1.8 && t < 2.3 ? 0 : 0.5 + (t % 0.5) * 0.5;
    const sample =
      Math.sin(2 * Math.PI * 220 * t) * 0.6 +
      Math.sin(2 * Math.PI * 440 * t) * 0.3 +
      Math.sin(2 * Math.PI * 660 * t) * 0.1;
    const value = Math.max(-1, Math.min(1, sample * amplitude * envelope));
    pcm.writeInt16LE(Math.round(value * 32_767), frame * 2);
  }
  return pcm16Wav(pcm);
}

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "audition-encode-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("encoding twice from the same native render gives the same bytes", (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg is not on PATH");
  withTemp((dir) => {
    const wav = join(dir, "source.wav");
    writeFileSync(wav, syntheticNativeWav());
    const a = join(dir, "a.mp3");
    const b = join(dir, "b.mp3");
    encodeAuditionMp3({ input: wav, output: a });
    encodeAuditionMp3({ input: wav, output: b });
    assert.deepEqual(readFileSync(a), readFileSync(b), "the encoder is deterministic for one input");
  });
});

test("the committed format is mono, 24 kHz, at the surviving bitrate, and adds no gain", (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg is not on PATH");
  withTemp((dir) => {
    const wav = join(dir, "source.wav");
    const mp3 = join(dir, "clip.mp3");
    writeFileSync(wav, syntheticNativeWav());
    encodeAuditionMp3({ input: wav, output: mp3 });

    const facts = mp3Facts(new Uint8Array(readFileSync(mp3)));
    assert.equal(facts.sampleRate, AUDITION_SAMPLE_RATE);
    assert.equal(facts.channels, AUDITION_CHANNELS);
    assert.equal(facts.bitrateKbps, AUDITION_BITRATE_KBPS);
    assert.equal(facts.constantBitrate, true);

    const source = analyseLevel(
      decodePcm(new Uint8Array(readFileSync(wav)).subarray(44), {
        sampleRate: REFERENCE_SAMPLE_RATE,
        channels: AUDITION_CHANNELS,
      }),
    );
    const encoded = analyseLevel(
      decodePcm(decodeAuditionMp3(mp3), {
        sampleRate: AUDITION_SAMPLE_RATE,
        channels: AUDITION_CHANNELS,
      }),
    );
    assert.ok(source.measured && encoded.measured, "both sides are measurable");
    assert.ok(
      Math.abs(encoded.integratedLufs - source.integratedLufs) <= 0.75,
      `encoding moved the level: ${source.integratedLufs} → ${encoded.integratedLufs} LUFS`,
    );
  });
});
