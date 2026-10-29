/**
 * What an audition clip actually is, read from the bytes the browser downloads.
 *
 * The clip test has to be able to say "this MP3 is 64 kbps and will not survive
 * a second encode" without ffmpeg, a manifest's word or a live call. MP3 frame
 * headers carry exactly the three facts that matter for a preview — sample
 * rate, bitrate and channel count — plus enough to count the audio's duration,
 * so this module is a pure reader over the committed file.
 *
 * Only MPEG Layer III is accepted: the audition clips are encoded that way, and
 * a file in another layer or another container is refused rather than measured
 * as if it were something it is not.
 */

export type Mp3FactsErrorCode = "not-mp3" | "truncated" | "unsupported";

export class Mp3FactsError extends Error {
  constructor(
    readonly code: Mp3FactsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Mp3FactsError";
  }
}

export type Mp3Facts = {
  /** Mode of the frames' bitrate index, kbps. */
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  /** Layer III frames counted in the file. */
  frames: number;
  /** Audio duration the frames account for. Encoder padding is not trimmed. */
  durationMs: number;
  /** True when every frame reports the same bitrate. */
  constantBitrate: boolean;
};

/** MPEG-1 Layer III bitrates, index 0 is "free" and 15 is invalid. */
const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** MPEG-2 / 2.5 Layer III bitrates. */
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

const SAMPLE_RATES: Record<"mpeg1" | "mpeg2" | "mpeg2.5", number[]> = {
  mpeg1: [44_100, 48_000, 32_000],
  mpeg2: [22_050, 24_000, 16_000],
  "mpeg2.5": [11_025, 12_000, 8_000],
};

type FrameHeader = {
  version: "mpeg1" | "mpeg2" | "mpeg2.5";
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  /** Samples per frame per channel: 1152 at MPEG-1, 576 at MPEG-2/2.5. */
  samplesPerFrame: number;
  frameBytes: number;
};

function header(bytes: Uint8Array, offset: number): FrameHeader | null {
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  // 01 is Layer III; 00 is reserved. Layer I/II files are a different encoder.
  if (layerBits !== 0x01) return null;
  const version = versionBits === 0x03 ? "mpeg1" : versionBits === 0x02 ? "mpeg2" : versionBits === 0x00 ? "mpeg2.5" : null;
  if (!version) return null;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null;

  const bitrateKbps = (version === "mpeg1" ? MPEG1_LAYER3_KBPS : MPEG2_LAYER3_KBPS)[bitrateIndex];
  if (!bitrateKbps) return null; // free-format bitrate cannot be read from the header

  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const samplesPerFrame = version === "mpeg1" ? 1152 : 576;
  const frameBytes = Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;
  if (frameBytes < 4) return null;

  return {
    version,
    bitrateKbps,
    sampleRate,
    channels: (b3 >> 6) === 0x03 ? 1 : 2,
    samplesPerFrame,
    frameBytes,
  };
}

/** Skip an ID3v2 tag if one is present; ffmpeg is asked not to write one. */
function audioOffset(bytes: Uint8Array): number {
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

export function mp3Facts(bytes: Uint8Array): Mp3Facts {
  const start = audioOffset(bytes);
  const first = header(bytes, start);
  if (!first) {
    throw new Mp3FactsError(
      "not-mp3",
      `no MPEG Layer III frame at byte ${start}: the file is not an MP3 preview`,
    );
  }

  let offset = start;
  let frames = 0;
  let constantBitrate = true;
  while (offset + 4 <= bytes.length) {
    const frame = header(bytes, offset);
    if (!frame) {
      // A trailing tag or padding after the last frame is not audio. Anything
      // else in the middle means the file is damaged, not merely finished.
      if (bytes.length - offset < 4) break;
      throw new Mp3FactsError(
        "truncated",
        `damaged frame header at byte ${offset} after ${frames} frames`,
      );
    }
    if (
      frame.sampleRate !== first.sampleRate ||
      frame.channels !== first.channels ||
      frame.bitrateKbps !== first.bitrateKbps
    ) {
      constantBitrate = false;
    }
    offset += frame.frameBytes;
    frames++;
  }
  if (frames === 0) {
    throw new Mp3FactsError("truncated", "no complete MPEG Layer III frame");
  }

  return {
    bitrateKbps: first.bitrateKbps,
    sampleRate: first.sampleRate,
    channels: first.channels,
    frames,
    durationMs: Math.round((frames * first.samplesPerFrame * 1000) / first.sampleRate),
    constantBitrate,
  };
}
