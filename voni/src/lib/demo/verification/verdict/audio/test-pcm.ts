/**
 * Synthetic PCM for the audio evaluators' tests.
 *
 * Every value in a test is built here from a known signal (a tone, a hole, a
 * fade, a clip) rather than from the analyser's own output, so a test can
 * disagree with the implementation. Files are written with the same PCM16 WAV
 * shape the delivered capture writes (`delivered-capture.ts`).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecodedAudio } from "@/lib/audio/format-facts";

export const TEST_RATE = 24_000;

export function silence(seconds: number, sampleRate = TEST_RATE): DecodedAudio {
  const frames = Math.round(seconds * sampleRate);
  return {
    samples: new Int16Array(frames),
    facts: {
      container: "wav",
      sampleRate,
      channels: 1,
      bitsPerSample: 16,
      byteRate: sampleRate * 2,
      dataBytes: frames * 2,
      frameCount: frames,
      durationSeconds: frames / sampleRate,
    },
  };
}

/** A steady tone at `amplitude` (0..1) of full scale. */
export function tone(
  seconds: number,
  options: { sampleRate?: number; amplitude?: number; frequency?: number } = {},
): DecodedAudio {
  const sampleRate = options.sampleRate ?? TEST_RATE;
  const amplitude = options.amplitude ?? 0.2;
  const frequency = options.frequency ?? 220;
  const frames = Math.round(seconds * sampleRate);
  const samples = new Int16Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate);
    samples[index] = Math.round(value * amplitude * 32767);
  }
  return {
    samples,
    facts: {
      container: "wav",
      sampleRate,
      channels: 1,
      bitsPerSample: 16,
      byteRate: sampleRate * 2,
      dataBytes: frames * 2,
      frameCount: frames,
      durationSeconds: frames / sampleRate,
    },
  };
}

/** Replace [startSeconds, endSeconds) with digital silence. */
export function hole(
  audio: DecodedAudio,
  startSeconds: number,
  endSeconds: number,
): DecodedAudio {
  const copy = new Int16Array(audio.samples);
  const start = Math.max(0, Math.round(startSeconds * audio.facts.sampleRate));
  const end = Math.min(copy.length, Math.round(endSeconds * audio.facts.sampleRate));
  copy.fill(0, start, end);
  return { samples: copy, facts: { ...audio.facts } };
}

/** One full-scale impulse (a click), leaving the surrounding signal intact. */
export function click(audio: DecodedAudio, atSeconds: number): DecodedAudio {
  const copy = new Int16Array(audio.samples);
  const at = Math.min(copy.length - 1, Math.max(1, Math.round(atSeconds * audio.facts.sampleRate)));
  copy[at] = 20_000;
  copy[at - 1] = -20_000;
  return { samples: copy, facts: { ...audio.facts } };
}

/** A run of clipped samples: the device's overload, recorded as full scale. */
export function clipped(audio: DecodedAudio, atSeconds: number, samples = 8): DecodedAudio {
  const copy = new Int16Array(audio.samples);
  const at = Math.max(0, Math.round(atSeconds * audio.facts.sampleRate));
  for (let index = 0; index < samples && at + index < copy.length; index += 1) {
    copy[at + index] = index % 2 === 0 ? 32_767 : -32_768;
  }
  return { samples: copy, facts: { ...audio.facts } };
}

/** A linear fade to digital silence over `ms` starting at `atSeconds`. */
export function fade(
  audio: DecodedAudio,
  atSeconds: number,
  ms: number,
): DecodedAudio {
  const copy = new Int16Array(audio.samples);
  const start = Math.max(0, Math.round(atSeconds * audio.facts.sampleRate));
  const frames = Math.round((ms / 1000) * audio.facts.sampleRate);
  for (let index = 0; index < frames && start + index < copy.length; index += 1) {
    const gain = 1 - index / frames;
    copy[start + index] = Math.round(copy[start + index] * gain);
  }
  copy.fill(0, Math.min(copy.length, start + frames));
  return { samples: copy, facts: { ...audio.facts } };
}

/** Standard 44-byte-header PCM16 mono WAV, the delivered capture's shape. */
export function wavBytes(audio: DecodedAudio): Buffer {
  const dataBytes = audio.samples.length * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(audio.facts.channels, 22);
  bytes.writeUInt32LE(audio.facts.sampleRate, 24);
  bytes.writeUInt32LE(audio.facts.sampleRate * audio.facts.channels * 2, 28);
  bytes.writeUInt16LE(audio.facts.channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < audio.samples.length; index += 1) {
    bytes.writeInt16LE(audio.samples[index]!, 44 + index * 2);
  }
  return bytes;
}

export function writeWav(name: string, audio: DecodedAudio): string {
  const dir = mkdtempSync(join(tmpdir(), "dv21-audio-"));
  const file = join(dir, name);
  writeFileSync(file, wavBytes(audio));
  return file;
}
