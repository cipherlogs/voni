/**
 * Decode the platform's Opus recording to interleaved s16le at the rate the
 * platform declares.
 *
 * Opus always decodes at 48 kHz, whatever the recording's original rate was.
 * Reading the decoded bytes as if they were the metadata rate turns a 60 s
 * 24 kHz call into a 120 s 24 kHz file: half speed, half pitch, and every
 * measurement after it is wrong. The `-ar` argument restores the recording's
 * own rate (the rate in the platform metadata), which is the rate this module
 * promises; it is not a client-side resample of live audio.
 */
import { spawnSync } from "node:child_process";

export function decodeRecordingArgs(audioPath: string, sampleRate: number): string[] {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sample rate must be a positive integer (got ${sampleRate})`);
  }
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    audioPath,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    String(sampleRate),
    "-f",
    "s16le",
    "pipe:1",
  ];
}

/** The decoded s16le frames, or `null` when ffmpeg could not decode the file. */
export function decodeRecordingPcm(audioPath: string, sampleRate: number): Buffer | null {
  const result = spawnSync("ffmpeg", decodeRecordingArgs(audioPath, sampleRate), {
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout) && result.stdout.byteLength > 0
    ? result.stdout
    : null;
}
