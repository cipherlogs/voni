/**
 * The only encoder the audition clips pass through.
 *
 * A clip is the voice at its native level, so the encoder is a format change
 * and nothing else: mono, the session's own 24 kHz, CBR at the format's top,
 * no metadata, no replay-gain tag, no ID3. `-fflags +bitexact` keeps the bytes
 * reproducible for the same input, which is what makes "run the script twice"
 * comparable rather than a remix.
 *
 * ffmpeg and libmp3lame are the repo's existing audio tooling (the call sounds
 * and the capture scripts already need them).
 */
import { execFileSync } from "node:child_process";

export const AUDITION_SAMPLE_RATE = 24_000;
export const AUDITION_CHANNELS = 1;
/** MPEG-2 Layer III at 24 kHz tops out at 160 kbps. */
export const AUDITION_BITRATE_KBPS = 160;

function ffmpegArgs(input: string, output: string, bitrateKbps: number): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-c:a",
    "libmp3lame",
    "-b:a",
    `${bitrateKbps}k`,
    "-ar",
    String(AUDITION_SAMPLE_RATE),
    "-ac",
    String(AUDITION_CHANNELS),
    // No Xing/Info header and no ID3: a preview is frames of audio, so the
    // committed bytes parse the same way on every machine.
    "-write_xing",
    "0",
    "-id3v2_version",
    "0",
    "-write_id3v1",
    "0",
    output,
  ];
}

/** Encode a native PCM WAV to the committed preview format. */
export function encodeAuditionMp3(opts: {
  input: string;
  output: string;
  bitrateKbps?: number;
}): void {
  execFileSync("ffmpeg", ffmpegArgs(opts.input, opts.output, opts.bitrateKbps ?? AUDITION_BITRATE_KBPS), {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** Decode an MP3 back to interleaved s16le at the clip's own rate. */
export function decodeAuditionMp3(input: string): Uint8Array {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ar",
      String(AUDITION_SAMPLE_RATE),
      "-ac",
      String(AUDITION_CHANNELS),
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  return new Uint8Array(raw);
}

/** True when the machine has the encoder the clip script needs. */
export function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
