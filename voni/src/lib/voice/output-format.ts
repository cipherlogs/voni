/**
 * The resolved output audio format the server applied to a session.
 *
 * `session.ready` echoes the full resolved config, including
 * `output.format`. The client plays at the rate and encoding it was told;
 * assuming PCM16 at 24 kHz turns any other resolved format into a silent
 * speed or codec change. 24 kHz PCM16 is only the fallback when the
 * confirmation carries no format at all.
 *
 * See docs/agents/assemblyai.md and the Agent API's audio-format reference:
 * `audio/pcm` is 16-bit signed LE, `audio/pcmu`/`audio/pcma` are 8 kHz G.711.
 */

/**
 * Fallback for a confirmation that echoes no rate. The API's native output is
 * 24 kHz PCM16; this is a named default, not the contract — a resolved rate
 * always wins.
 */
export const DEFAULT_OUTPUT_SAMPLE_RATE = 24_000;

/** Fallback for a confirmation that echoes no encoding: the API's default. */
export const DEFAULT_OUTPUT_ENCODING = "audio/pcm";

/** The output encodings this client can render correctly. */
export type OutputEncoding = "audio/pcm" | "audio/pcmu" | "audio/pcma";

/** The rate each encoding implies when the confirmation carries none. */
const ENCODING_FALLBACK_RATE: Record<OutputEncoding, number> = {
  "audio/pcm": DEFAULT_OUTPUT_SAMPLE_RATE,
  // G.711 is a telephony codec: 8 kHz, one byte per sample.
  "audio/pcmu": 8_000,
  "audio/pcma": 8_000,
};

const SUPPORTED_ENCODINGS = new Set<string>(Object.keys(ENCODING_FALLBACK_RATE));

/** The confirmation named an output format the client cannot play correctly. */
export class OutputFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputFormatError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function outputFormat(config: unknown): Record<string, unknown> | null {
  return record(record(record(config)?.output)?.format);
}

/**
 * Read `config.output.format.encoding` from a session confirmation.
 *
 * Absent means the server echoed no encoding, so the API's default applies. An
 * encoding that is present but unplayable is an explicit refusal: treating
 * mu-law or A-law as PCM16 would play noise, and skipping it would play
 * silence, both with no visible failure.
 */
export function resolveOutputEncoding(config: unknown): OutputEncoding {
  const encoding = outputFormat(config)?.encoding;
  if (encoding === undefined || encoding === null) return DEFAULT_OUTPUT_ENCODING;
  if (typeof encoding === "string" && SUPPORTED_ENCODINGS.has(encoding)) {
    return encoding as OutputEncoding;
  }
  throw new OutputFormatError(
    `The call's output encoding (${JSON.stringify(encoding)}) is unsupported.`,
  );
}

/**
 * Read `config.output.format.sample_rate` from a session confirmation.
 *
 * Absent means the server echoed no rate, so the encoding's implied rate
 * applies (8 kHz for G.711, 24 kHz for PCM16). A rate that is present but
 * unplayable is an explicit refusal: guessing would play the caller's audio at
 * the wrong speed with no visible failure.
 */
export function resolveOutputSampleRate(config: unknown): number {
  const encoding = resolveOutputEncoding(config);
  const rate = outputFormat(config)?.sample_rate;
  if (rate === undefined || rate === null) return ENCODING_FALLBACK_RATE[encoding];
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate <= 0) {
    throw new OutputFormatError(
      `The call's output sample rate (${String(rate)}) is unsupported.`,
    );
  }
  return rate;
}

/** The resolved rate and encoding, read together so one cannot be guessed. */
export function resolveOutputFormat(config: unknown): {
  sampleRate: number;
  encoding: OutputEncoding;
} {
  const encoding = resolveOutputEncoding(config);
  return { sampleRate: resolveOutputSampleRate(config), encoding };
}

/** G.711 mu-law byte -> signed linear sample (ITU G.711 reference decoder). */
function mulawToLinear(byte: number): number {
  const value = ~byte & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -magnitude : magnitude;
}

/** G.711 A-law byte -> signed linear sample (ITU G.711 reference decoder). */
function alawToLinear(byte: number): number {
  const value = byte ^ 0x55;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  const magnitude =
    exponent === 0
      ? (mantissa << 4) + 8
      : ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? magnitude : -magnitude;
}

/**
 * Turn one `reply.audio` chunk into little-endian PCM16 mono, the only sample
 * form the playout takes.
 *
 * PCM16 passes through untouched. G.711 expands one byte to one sample, so a
 * silent mu-law/A-law chunk stays silence instead of being refused as
 * corruption. A chunk that cannot be whole samples is refused: zero-padding
 * the tail would play corruption as silence.
 */
export function decodeOutputAudio(
  bytes: Uint8Array,
  encoding: OutputEncoding,
): Uint8Array {
  if (encoding === "audio/pcm") {
    if (bytes.length % 2 !== 0) {
      throw new OutputFormatError(
        `The call's audio chunk is malformed for encoding ${JSON.stringify(encoding)}.`,
      );
    }
    return bytes;
  }
  if (encoding === "audio/pcmu" || encoding === "audio/pcma") {
    const decode = encoding === "audio/pcmu" ? mulawToLinear : alawToLinear;
    const pcm = new Uint8Array(bytes.length * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < bytes.length; i++) {
      view.setInt16(i * 2, decode(bytes[i]!), true);
    }
    return pcm;
  }
  throw new OutputFormatError(
    `The call's output encoding (${JSON.stringify(encoding)}) is unsupported.`,
  );
}
