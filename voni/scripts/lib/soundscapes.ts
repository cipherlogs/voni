/**
 * The committed soundscape beds: one hashed PCM WAV and one sidecar per id.
 *
 * A scenario names a soundscape id; the adapters mix the matching 24 kHz mono
 * PCM16 bed under the caller. The bed is evidence, so it is committed, hashed
 * and described beside its file, and this loader refuses anything that does not
 * agree with that record. There is no empty state and no default: a missing
 * file, a sidecar that fails to parse, a file the format reader rejects, a
 * changed hash, a misdescribed format and a drifted duration are each a named
 * `SoundscapeError` carrying the path and the command that produces a real bed.
 *
 * The loader never resamples. The mixer reads 24 kHz mono PCM16, so a file at
 * another rate is refused by name rather than converted behind the caller's
 * back.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AudioFactsError,
  decodeWav,
  type AudioFacts,
  type DecodedAudio,
} from "@/lib/audio/format-facts";

export const SOUNDSCAPE_SCHEMA_VERSION = 1;

/** The ids the repository commits a bed for. */
export const SOUNDSCAPE_IDS = ["television"] as const;

export type SoundscapeId = (typeof SOUNDSCAPE_IDS)[number];

/** The one format the mixer accepts: 24 kHz mono PCM16. */
export const SOUNDSCAPE_SAMPLE_RATE = 24_000;
export const SOUNDSCAPE_CHANNELS = 1;
export const SOUNDSCAPE_BITS_PER_SAMPLE = 16;

/** Committed evidence, resolved from this module so no cwd can move it. */
export const SOUNDSCAPE_DIR = fileURLToPath(
  new URL("../../evidence/soundscapes/", import.meta.url),
);

/**
 * How a bed is reproduced from the owner-supplied source. It is documentation,
 * not a live-run dependency: the committed WAV is the evidence, and a changed
 * hash refuses until this command is run deliberately and the pair re-recorded.
 */
export const SOUNDSCAPE_COMMANDS: Readonly<Record<SoundscapeId, string>> = {
  television:
    'yt-dlp -x --audio-format wav -o /tmp/television-source.wav "https://www.youtube.com/watch?v=-q4pH8bZ1SU"' +
    " && ffmpeg -ss 1800 -t 30 -i /tmp/television-source.wav -ac 1 -ar 24000 -c:a pcm_s16le" +
    " voni/evidence/soundscapes/television.wav",
};

export type SoundscapeProvenance = {
  schemaVersion: typeof SOUNDSCAPE_SCHEMA_VERSION;
  id: SoundscapeId;
  /** File name beside this sidecar. */
  file: string;
  /** Calendar day of the excerpt, `YYYY-MM-DD`. */
  capturedOn: string;
  /** Where the audio came from, in one repeatable sentence. */
  source: string;
  /** How the excerpt was produced, in one repeatable sentence. */
  method: string;
  sampleRate: typeof SOUNDSCAPE_SAMPLE_RATE;
  channels: typeof SOUNDSCAPE_CHANNELS;
  bitsPerSample: typeof SOUNDSCAPE_BITS_PER_SAMPLE;
  /** Sidecar-declared duration, checked against the decoded file. */
  durationMs: number;
  sha256: string;
  /** Why this bed exists rather than digital silence. */
  why: string;
  /** The owner's rights decision for the committed excerpt. */
  rights: string;
  /** What the bed is never evidence of. */
  notUsedFor: string;
};

export type SoundscapeErrorCode =
  | "soundscape-missing"
  | "soundscape-sidecar-invalid"
  | "soundscape-unreadable"
  | "soundscape-audio-mismatch";

/** A refused bed. A caller can branch on `code`; nothing is assumed. */
export class SoundscapeError extends Error {
  constructor(
    readonly code: SoundscapeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SoundscapeError";
  }
}

export type SoundscapeBed = {
  readonly provenance: SoundscapeProvenance;
  /** Interleaved little-endian 16-bit samples, no header. */
  readonly pcm: Uint8Array;
  readonly path: string;
  readonly sidecarPath: string;
};

function sidecarName(wavFile: string): string {
  return wavFile.replace(/\.wav$/, ".json");
}

function invalid(where: string, detail: string): SoundscapeError {
  return new SoundscapeError(
    "soundscape-sidecar-invalid",
    `soundscape sidecar invalid: ${where}: ${detail}.`,
  );
}

function requiredString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(where, `"${field}" must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInt(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalid(where, `"${field}" must be a positive integer`);
  }
  return value;
}

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function objectAt(value: unknown, field: string, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(where, `"${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseProvenance(raw: unknown, id: SoundscapeId, where: string): SoundscapeProvenance {
  const root = objectAt(raw, "sidecar", where);
  if (root.schemaVersion !== SOUNDSCAPE_SCHEMA_VERSION) {
    throw invalid(where, `"schemaVersion" must be ${SOUNDSCAPE_SCHEMA_VERSION}`);
  }

  const declaredId = requiredString(root.id, "id", where);
  if (!(SOUNDSCAPE_IDS as readonly string[]).includes(declaredId)) {
    throw invalid(where, `"id" must be one of ${SOUNDSCAPE_IDS.join(", ")}`);
  }
  const capturedOn = requiredString(root.capturedOn, "capturedOn", where);
  if (!isCalendarDay(capturedOn)) {
    throw invalid(where, `"capturedOn" must be a real calendar day as YYYY-MM-DD, got ${capturedOn}`);
  }

  const sampleRate = requiredPositiveInt(root.sampleRate, "sampleRate", where);
  if (sampleRate !== SOUNDSCAPE_SAMPLE_RATE) {
    throw invalid(
      where,
      `"sampleRate" must be ${SOUNDSCAPE_SAMPLE_RATE}; a bed at another rate is not resampled at load time`,
    );
  }
  const channels = requiredPositiveInt(root.channels, "channels", where);
  if (channels !== SOUNDSCAPE_CHANNELS) {
    throw invalid(where, `"channels" must be ${SOUNDSCAPE_CHANNELS}; the mixer reads mono`);
  }
  const bitsPerSample = requiredPositiveInt(root.bitsPerSample, "bitsPerSample", where);
  if (bitsPerSample !== SOUNDSCAPE_BITS_PER_SAMPLE) {
    throw invalid(where, `"bitsPerSample" must be ${SOUNDSCAPE_BITS_PER_SAMPLE}`);
  }

  const sha256 = requiredString(root.sha256, "sha256", where);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw invalid(where, `"sha256" must be 64 lowercase hex characters`);
  }

  return {
    schemaVersion: SOUNDSCAPE_SCHEMA_VERSION,
    id: declaredId as SoundscapeId,
    file: requiredString(root.file, "file", where),
    capturedOn,
    source: requiredString(root.source, "source", where),
    method: requiredString(root.method, "method", where),
    sampleRate: SOUNDSCAPE_SAMPLE_RATE,
    channels: SOUNDSCAPE_CHANNELS,
    bitsPerSample: SOUNDSCAPE_BITS_PER_SAMPLE,
    durationMs: requiredPositiveInt(root.durationMs, "durationMs", where),
    sha256,
    why: requiredString(root.why, "why", where),
    rights: requiredString(root.rights, "rights", where),
    notUsedFor: requiredString(root.notUsedFor, "notUsedFor", where),
  };
}

function describeFormat(facts: Pick<AudioFacts, "sampleRate" | "channels" | "bitsPerSample">): string {
  return `${facts.sampleRate} Hz/${facts.channels} ch/${facts.bitsPerSample}-bit`;
}

function factsMismatch(path: string, label: string, actual: AudioFacts, command: string): SoundscapeError {
  return new SoundscapeError(
    "soundscape-audio-mismatch",
    `soundscape audio mismatch: ${path}: the sidecar says ${label}, the file is ${describeFormat(actual)}. ` +
      `Re-create the bed with \`${command}\` rather than editing either file.`,
  );
}

function durationMismatch(path: string, declaredMs: number, actualMs: number, command: string): SoundscapeError {
  return new SoundscapeError(
    "soundscape-audio-mismatch",
    `soundscape audio mismatch: ${path}: the sidecar says ${declaredMs} ms, the file is ${actualMs} ms. ` +
      `Re-create the bed with \`${command}\` rather than editing either file.`,
  );
}

/** Convert decoded samples to the interleaved little-endian bytes the mixer takes. */
function pcm16Bytes(audio: DecodedAudio): Uint8Array {
  const bytes = new Uint8Array(audio.samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < audio.samples.length; index += 1) {
    view.setInt16(index * 2, audio.samples[index] as number, true);
  }
  return bytes;
}

/**
 * Load one committed bed.
 *
 * Throws `SoundscapeError` by name rather than returning silence: a scenario
 * naming a bed the caller did not hear would measure nothing.
 */
export function loadSoundscape(
  id: SoundscapeId,
  options: { directory?: string } = {},
): SoundscapeBed {
  const directory = options.directory ?? SOUNDSCAPE_DIR;
  const fileName = `${id}.wav`;
  const path = resolve(directory, fileName);
  const sidecarPath = resolve(directory, sidecarName(fileName));
  const command = SOUNDSCAPE_COMMANDS[id];

  const absent = [path, sidecarPath].filter((candidate) => !existsSync(candidate));
  if (absent.length > 0) {
    throw new SoundscapeError(
      "soundscape-missing",
      `soundscape missing: ${absent.join(" and ")}. A bed is committed evidence, never an empty default. ` +
        `Re-create it with \`${command}\`, then load the pair through this module.`,
    );
  }

  let sidecarText: string;
  try {
    sidecarText = readFileSync(sidecarPath, "utf8");
  } catch (error) {
    throw new SoundscapeError(
      "soundscape-unreadable",
      `soundscape unreadable: ${sidecarPath}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Re-create the bed with \`${command}\`.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(sidecarText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SoundscapeError(
      "soundscape-sidecar-invalid",
      `soundscape sidecar invalid: ${sidecarPath}: ${detail}. Re-create the bed with \`${command}\`.`,
    );
  }
  let provenance: SoundscapeProvenance;
  try {
    provenance = parseProvenance(raw, id, sidecarPath);
    if (provenance.id !== id) {
      throw invalid(sidecarPath, `it names "${provenance.id}", but ${fileName} is "${id}"`);
    }
    if (basename(provenance.file) !== fileName) {
      throw invalid(sidecarPath, `"file" must name ${fileName}, got ${provenance.file}`);
    }
  } catch (error) {
    if (error instanceof SoundscapeError) {
      throw new SoundscapeError(
        error.code,
        `${error.message} Re-create the bed with \`${command}\`.`,
      );
    }
    throw error;
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new SoundscapeError(
      "soundscape-unreadable",
      `soundscape unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Re-create the bed with \`${command}\`.`,
    );
  }

  let audio: DecodedAudio;
  try {
    audio = decodeWav(bytes);
  } catch (error) {
    const reason =
      error instanceof AudioFactsError ? error.message : error instanceof Error ? error.message : String(error);
    throw new SoundscapeError(
      "soundscape-unreadable",
      `soundscape unreadable: ${path}: ${reason}. The mixer reads 24 kHz mono PCM16 WAV; ` +
        `re-create the bed with \`${command}\`.`,
    );
  }

  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== provenance.sha256) {
    throw new SoundscapeError(
      "soundscape-audio-mismatch",
      `soundscape audio mismatch: ${path}: sha256 ${actualSha} does not match the sidecar's ` +
        `${provenance.sha256}. Re-create the bed with \`${command}\` rather than editing either file.`,
    );
  }

  if (
    audio.facts.sampleRate !== provenance.sampleRate ||
    audio.facts.channels !== provenance.channels ||
    audio.facts.bitsPerSample !== provenance.bitsPerSample
  ) {
    throw factsMismatch(path, describeFormat(provenance), audio.facts, command);
  }

  const actualMs = Math.round(audio.facts.durationSeconds * 1000);
  if (actualMs !== provenance.durationMs) {
    throw durationMismatch(path, provenance.durationMs, actualMs, command);
  }

  return { provenance, pcm: pcm16Bytes(audio), path, sidecarPath };
}

/**
 * Every committed bed as the adapters take it: id to interleaved PCM16 bytes.
 *
 * A missing bed throws; there is no partial map that quietly omits an id.
 */
export function loadSoundscapes(
  options: { directory?: string } = {},
): Readonly<Record<SoundscapeId, Uint8Array>> {
  const beds = {} as Record<SoundscapeId, Uint8Array>;
  for (const id of SOUNDSCAPE_IDS) {
    beds[id] = loadSoundscape(id, options).pcm;
  }
  return beds;
}
