/**
 * Facts about a kept platform recording channel.
 *
 * The platform's recording is the one capture that shows what the agent
 * actually sent and what the caller actually said, so both channels are kept
 * as files at the recording's own rate. Nothing here resamples: a 16 kHz
 * capture stays 16 kHz, because a resampled copy would move a rate defect into
 * the measurement and hide it.
 *
 * The module is pure — metadata and bytes in, bytes and paths out — so the
 * capture rules can be asserted without a session, a network or ffmpeg.
 */
import { join } from "node:path";

export type RecordingCaptureErrorCode =
  | "missing-sample-rate"
  | "missing-agent-channel"
  | "empty-agent-channel"
  | "empty-caller-channel"
  | "truncated-capture"
  | "decoder-unavailable";

/** A refused capture. A caller can branch on `code`; nothing is guessed. */
export class RecordingCaptureError extends Error {
  constructor(
    readonly code: RecordingCaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecordingCaptureError";
  }
}

export type RecordingMetadata = {
  sample_rate?: unknown;
  channels?: unknown;
};

export type RecordingFormat = {
  /** Frames per second, as the platform recorded them. */
  sampleRate: number;
  /** Interleaved channels; the agent channel needs at least 2. */
  channels: number;
};

/** The agent speaks on the second channel; the caller owns the first. */
const CALLER_CHANNEL_INDEX = 0;
const AGENT_CHANNEL_INDEX = 1;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Read the recording's own format from the platform metadata. A missing rate
 * or a mono capture is refused by name: the old default of 24 kHz is exactly
 * the assumption this work removes.
 */
export function resolveRecordingFormat(metadata: RecordingMetadata): RecordingFormat {
  const sampleRate = positiveInt(metadata.sample_rate);
  if (sampleRate === null) {
    throw new RecordingCaptureError(
      "missing-sample-rate",
      `Recording does not report a sample rate (got ${String(metadata.sample_rate)}); refusing to assume one.`,
    );
  }
  const channels = positiveInt(metadata.channels);
  if (channels === null || channels < AGENT_CHANNEL_INDEX + 1) {
    throw new RecordingCaptureError(
      "missing-agent-channel",
      `Recording reports ${channels ?? "no"} channel(s); the agent channel needs a stereo recording (caller left, agent right).`,
    );
  }
  return { sampleRate, channels };
}

/**
 * Split one channel out of interleaved s16le frames, frame for frame. The
 * output length is the capture's own length; no rate conversion happens.
 */
export function channelPcm(
  interleaved: Uint8Array,
  format: RecordingFormat,
  channelIndex: number,
): Uint8Array {
  if (!Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex >= format.channels) {
    throw new RangeError(
      `Channel ${channelIndex} does not exist in a ${format.channels}-channel recording.`,
    );
  }
  const blockAlign = format.channels * BYTES_PER_SAMPLE;
  if (interleaved.byteLength % blockAlign !== 0) {
    throw new RecordingCaptureError(
      "truncated-capture",
      `Capture ends mid-frame: ${interleaved.byteLength} bytes is not a multiple of ${blockAlign}.`,
    );
  }
  const frameCount = interleaved.byteLength / blockAlign;

  const input = new DataView(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
  const output = new Uint8Array(frameCount * BYTES_PER_SAMPLE);
  const view = new DataView(output.buffer);
  for (let frame = 0; frame < frameCount; frame++) {
    view.setInt16(
      frame * BYTES_PER_SAMPLE,
      input.getInt16((frame * format.channels + channelIndex) * BYTES_PER_SAMPLE, true),
      true,
    );
  }
  return output;
}

/**
 * The caller channel, taken from the same decode as the agent channel. It is
 * refused by name when there is nothing to take, so a caller file can never be
 * filled from the agent's channel.
 */
export function callerChannelPcm(
  interleaved: Uint8Array,
  format: RecordingFormat,
): Uint8Array {
  const pcm = channelPcm(interleaved, format, CALLER_CHANNEL_INDEX);
  if (pcm.byteLength === 0) {
    throw new RecordingCaptureError(
      "empty-caller-channel",
      "Recording decoded to zero frames; refusing to write an empty caller channel.",
    );
  }
  return pcm;
}

/** The agent channel, refused by name when the recording has none to give. */
export function agentChannelPcm(
  interleaved: Uint8Array,
  format: RecordingFormat,
): Uint8Array {
  if (format.channels < AGENT_CHANNEL_INDEX + 1) {
    throw new RecordingCaptureError(
      "missing-agent-channel",
      `Recording has ${format.channels} channel(s); the agent channel needs a stereo recording.`,
    );
  }
  const pcm = channelPcm(interleaved, format, AGENT_CHANNEL_INDEX);
  if (pcm.byteLength === 0) {
    throw new RecordingCaptureError(
      "empty-agent-channel",
      "Recording decoded to zero frames; refusing to write an empty agent channel.",
    );
  }
  return pcm;
}

/** Wrap mono s16le PCM in a WAV whose header reports the recording's own rate. */
export function encodeMonoWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  if (pcm.byteLength === 0) {
    throw new RecordingCaptureError(
      "empty-agent-channel",
      "Refusing to write a WAV with no samples.",
    );
  }
  if (pcm.byteLength % BYTES_PER_SAMPLE !== 0) {
    throw new RecordingCaptureError(
      "truncated-capture",
      `PCM ends mid-sample: ${pcm.byteLength} bytes is not a multiple of ${BYTES_PER_SAMPLE}.`,
    );
  }

  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  const writeFourCC = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) out[offset + i] = text.charCodeAt(i);
  };
  writeFourCC(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeFourCC(8, "WAVE");
  writeFourCC(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeFourCC(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

/** Which channel of the platform recording a kept file holds. */
export const CAPTURE_CHANNELS = ["caller", "agent"] as const;

export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];

/**
 * A capture path a human can pair with the browser capture by session id. The
 * channel is in the name too, but the two files are told apart by content: the
 * names only say which one to open.
 */
export function captureFilePath(
  directory: string,
  sessionId: string,
  sampleRate: number,
  channel: CaptureChannel,
): string {
  return join(directory, `${sessionId}-${channel}-${sampleRate}hz.wav`);
}

/** A channel kept from the platform recording: bytes and the path they belong at. */
export type KeptChannel = {
  channel: CaptureChannel;
  /** Where the file belongs; the caller writes `wav` here. */
  path: string;
  /** A mono WAV whose header reports the recording's own rate. */
  wav: Uint8Array;
  frameCount: number;
};

/** A channel that could not be taken from the recording, and why. */
export type AbsentChannel = {
  channel: CaptureChannel;
  reason: string;
};

export type CaptureReport = {
  sessionId: string;
  /** The recording's own rate; every kept file reports it. */
  sampleRate: number;
  kept: KeptChannel[];
  absent: AbsentChannel[];
};

/**
 * Pair the recording's two channels into one report. Each channel is taken
 * independently, so a channel that cannot be produced is named as absent
 * instead of being filled with the other channel or a downmix. Nothing is
 * resampled: both files report the rate the platform recorded at.
 */
export function captureChannels(
  interleaved: Uint8Array | null,
  format: RecordingFormat,
  target: { directory: string; sessionId: string },
): CaptureReport {
  const kept: KeptChannel[] = [];
  const absent: AbsentChannel[] = [];

  for (const channel of CAPTURE_CHANNELS) {
    if (interleaved === null) {
      absent.push({ channel, reason: "the recording could not be decoded" });
      continue;
    }
    try {
      const pcm =
        channel === "caller"
          ? callerChannelPcm(interleaved, format)
          : agentChannelPcm(interleaved, format);
      kept.push({
        channel,
        path: captureFilePath(target.directory, target.sessionId, format.sampleRate, channel),
        wav: encodeMonoWav(pcm, format.sampleRate),
        frameCount: pcm.byteLength / BYTES_PER_SAMPLE,
      });
    } catch (error) {
      absent.push({ channel, reason: captureFailureReason(error) });
    }
  }

  return { sessionId: target.sessionId, sampleRate: format.sampleRate, kept, absent };
}

/**
 * One line per channel, each naming the session and (when kept) the path. The
 * session id is what lets a human pair a platform capture with the browser
 * capture of the same call; an absent channel says so instead of going quiet.
 */
export function describeCaptures(report: CaptureReport): string[] {
  const lines: string[] = [];
  for (const channel of CAPTURE_CHANNELS) {
    const kept = report.kept.find((entry) => entry.channel === channel);
    if (kept) {
      const seconds = (kept.frameCount / report.sampleRate).toFixed(2);
      lines.push(
        `Session ${report.sessionId}: ${channel} channel kept at ${kept.path} (${report.sampleRate} Hz, ${seconds} s).`,
      );
      continue;
    }
    const absent = report.absent.find((entry) => entry.channel === channel);
    lines.push(
      `Session ${report.sessionId}: ${channel} channel absent — ${absent?.reason ?? "not captured"}.`,
    );
  }
  return lines;
}

/** A refused channel is reported in words; an unexpected failure still throws. */
function captureFailureReason(error: unknown): string {
  if (error instanceof RecordingCaptureError || error instanceof RangeError) {
    return error.message;
  }
  throw error;
}

export type CaptureFlags = {
  /** Directory to keep the channel file in, or null to discard the capture. */
  keepAudioDir: string | null;
  /** Remote deletion is opt-in and never implied by keeping a file. */
  deleteRemote: boolean;
};

/** `--keep-audio` with no directory writes here; the path is gitignored. */
export const DEFAULT_CAPTURE_DIR = "voice-captures";

export function parseCaptureFlags(argv: readonly string[]): CaptureFlags {
  const index = argv.indexOf("--keep-audio");
  let keepAudioDir: string | null = null;
  if (index >= 0) {
    const value = argv[index + 1];
    keepAudioDir = !value || value.startsWith("--") ? DEFAULT_CAPTURE_DIR : value;
  }
  return { keepAudioDir, deleteRemote: argv.includes("--delete") };
}
