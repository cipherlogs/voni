/**
 * Format facts for a saved recording: the rate, channel count, duration and
 * byte rate a comparison needs before it can measure anything else.
 *
 * The core is pure — bytes in, facts out — so a saved file can be re-analysed
 * without a browser, network or database. A file is either a PCM WAV or raw
 * s16le; nothing is guessed from its length or extension.
 */
import { readFileSync } from "node:fs";

const BYTES_PER_SAMPLE = 2;

export type PcmFormat = {
  /** Frames per second per channel. */
  sampleRate: number;
  /** Interleaved channels, 1 (mono) or more. */
  channels: number;
};

export type AudioFacts = {
  container: "wav" | "pcm";
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Bytes of PCM sample data per second. */
  byteRate: number;
  /** Bytes of PCM sample data actually present. */
  dataBytes: number;
  /** Samples per channel. */
  frameCount: number;
  durationSeconds: number;
};

export type DecodedAudio = {
  facts: AudioFacts;
  /** Interleaved little-endian 16-bit samples. */
  samples: Int16Array;
};

export type AudioFactsErrorCode =
  | "not-wav"
  | "truncated"
  | "unsupported-format"
  | "invalid-format";

/** A refused input. A caller can branch on `code`; nothing is guessed. */
export class AudioFactsError extends Error {
  constructor(
    readonly code: AudioFactsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AudioFactsError";
  }
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function requirePositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AudioFactsError(
      "invalid-format",
      `${field} must be a positive integer, got ${value}.`,
    );
  }
}

function readSamples(
  bytes: Uint8Array,
  dataOffset: number,
  dataBytes: number,
): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(dataBytes / BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(dataOffset + i * BYTES_PER_SAMPLE, true);
  }
  return samples;
}

function factsFor(
  container: AudioFacts["container"],
  format: PcmFormat,
  dataBytes: number,
): AudioFacts {
  const blockAlign = format.channels * BYTES_PER_SAMPLE;
  const frameCount = dataBytes / blockAlign;
  return {
    container,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: BYTES_PER_SAMPLE * 8,
    byteRate: format.sampleRate * blockAlign,
    dataBytes,
    frameCount,
    durationSeconds: frameCount / format.sampleRate,
  };
}

/** Decode a PCM WAV. A headerless or truncated file is refused by name. */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  if (bytes.byteLength < 12 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WAVE") {
    throw new AudioFactsError("not-wav", "Input is not a RIFF/WAVE file.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 > bytes.byteLength) {
    throw new AudioFactsError("truncated", "RIFF chunk size exceeds the file length.");
  }

  let format: PcmFormat | null = null;
  let dataOffset = -1;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
    const id = fourcc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) {
      throw new AudioFactsError("truncated", `"${id}" chunk is shorter than its declared size.`);
    }
    if (id === "fmt ") {
      if (size < 16) {
        throw new AudioFactsError("invalid-format", `"fmt " chunk is ${size} bytes, needs 16.`);
      }
      const encoding = view.getUint16(body, true);
      if (encoding !== 1) {
        throw new AudioFactsError(
          "unsupported-format",
          `WAV encoding ${encoding} is not PCM; only 16-bit PCM is supported.`,
        );
      }
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const declaredByteRate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (bitsPerSample !== BYTES_PER_SAMPLE * 8) {
        throw new AudioFactsError(
          "unsupported-format",
          `WAV is ${bitsPerSample}-bit; only 16-bit PCM is supported.`,
        );
      }
      requirePositiveInt(channels, "channel count");
      requirePositiveInt(sampleRate, "sample rate");
      if (blockAlign !== channels * BYTES_PER_SAMPLE) {
        throw new AudioFactsError(
          "invalid-format",
          `block align ${blockAlign} does not match ${channels} channels of 16-bit PCM.`,
        );
      }
      if (declaredByteRate !== sampleRate * blockAlign) {
        throw new AudioFactsError(
          "invalid-format",
          `byte rate ${declaredByteRate} does not match ${sampleRate} Hz x ${blockAlign} bytes.`,
        );
      }
      format = { sampleRate, channels };
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = size;
    }
    offset = body + size + (size % 2);
  }

  if (!format) {
    throw new AudioFactsError("invalid-format", `WAV has no "fmt " chunk.`);
  }
  if (dataOffset < 0) {
    throw new AudioFactsError("invalid-format", `WAV has no "data" chunk.`);
  }
  const blockAlign = format.channels * BYTES_PER_SAMPLE;
  if (dataBytes % blockAlign !== 0) {
    throw new AudioFactsError(
      "truncated",
      `"data" chunk ends mid-frame: ${dataBytes} bytes is not a multiple of ${blockAlign}.`,
    );
  }

  return {
    facts: factsFor("wav", format, dataBytes),
    samples: readSamples(bytes, dataOffset, dataBytes),
  };
}

/** Decode headerless little-endian 16-bit PCM with caller-supplied facts. */
export function decodePcm(bytes: Uint8Array, format: PcmFormat): DecodedAudio {
  requirePositiveInt(format.sampleRate, "sample rate");
  requirePositiveInt(format.channels, "channel count");
  const blockAlign = format.channels * BYTES_PER_SAMPLE;
  if (bytes.byteLength % blockAlign !== 0) {
    throw new AudioFactsError(
      "truncated",
      `PCM ends mid-frame: ${bytes.byteLength} bytes is not a multiple of ${blockAlign}.`,
    );
  }
  return {
    facts: factsFor("pcm", format, bytes.byteLength),
    samples: readSamples(bytes, 0, bytes.byteLength),
  };
}

/**
 * Analyse a saved file. Raw PCM must carry its format explicitly; a WAV is
 * read from its own header. There is no third mode and no auto-detection.
 */
export function decodeAudioFile(
  path: string,
  options: { pcm?: PcmFormat } = {},
): DecodedAudio {
  const bytes = readFileSync(path);
  return options.pcm ? decodePcm(bytes, options.pcm) : decodeWav(bytes);
}
