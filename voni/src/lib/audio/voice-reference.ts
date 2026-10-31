/**
 * The committed voice reference: one line in one voice, rendered by the call's
 * own synthesis path and pinned by a sidecar.
 *
 * A5 judges timbre against a reference that cannot drift with a live call. The
 * reference is therefore a checked-in PCM WAV plus a JSON sidecar recording the
 * voice, the Locale, the exact line, the render method and the file's sha256.
 * The loader has no empty state: a missing file, a malformed sidecar, a hash
 * that no longer matches and a format the sidecar misdescribes are each a named
 * `VoiceReferenceError`.
 *
 * The render is the cascade's own (`voice-pipeline/scripts/render_reference.py`),
 * not the managed path's silent-greeting session: a cascade call is judged
 * against the synthesis client it actually runs.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AudioFactsError,
  decodeWav,
  type DecodedAudio,
} from "./format-facts";

export const VOICE_REFERENCE_SCHEMA_VERSION = 1;

/** The voice the English demo uses; the reference is its own greeting. */
export const VOICE_REFERENCE_VOICE = "audrey";
export const VOICE_REFERENCE_LOCALE = "en";

/** Committed evidence, resolved from this module so no cwd can move it. */
export const VOICE_REFERENCE_DIR = fileURLToPath(
  new URL("../../../evidence/voice-reference/", import.meta.url),
);

export const VOICE_REFERENCE_COMMAND =
  "cd voice-pipeline && python scripts/render_reference.py --body <audrey-body.json> --out-dir /tmp/refs --transport browser";

export type VoiceReferenceProvenance = {
  schemaVersion: typeof VOICE_REFERENCE_SCHEMA_VERSION;
  voice: string;
  locale: string;
  /** The exact line the reference renders, verbatim. */
  line: string;
  renderedOn: string;
  producedBy: string;
  method: "cascade-reference-render";
  vendor: {
    name: string;
    voiceId: string;
    model: string;
  };
  format: {
    transport: "browser";
    container: "wav";
    encoding: "pcm_s16le";
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
  };
  audio: {
    file: string;
    sha256: string;
    bytes: number;
    durationMs: number;
  };
};

export type VoiceReferenceErrorCode =
  | "reference-missing"
  | "reference-sidecar-invalid"
  | "reference-unreadable"
  | "reference-audio-mismatch";

/** A refused reference. A caller can branch on `code`; nothing is assumed. */
export class VoiceReferenceError extends Error {
  constructor(
    readonly code: VoiceReferenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceReferenceError";
  }
}

export type VoiceReference = {
  readonly provenance: VoiceReferenceProvenance;
  readonly audio: DecodedAudio;
  readonly path: string;
  readonly sidecarPath: string;
};

function invalid(where: string, detail: string): VoiceReferenceError {
  return new VoiceReferenceError(
    "reference-sidecar-invalid",
    `voice reference sidecar invalid: ${where}: ${detail}`,
  );
}

function text(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(where, `"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function positiveInt(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalid(where, `"${field}" must be a positive integer`);
  }
  return value;
}

function positiveNumber(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(where, `"${field}" must be a positive number`);
  }
  return value;
}

function recordOf(value: unknown, field: string, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(where, `"${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Parse one sidecar into provenance, refusing every drift by name. */
export function parseVoiceReferenceSidecar(
  value: unknown,
  where = "voice reference",
): VoiceReferenceProvenance {
  const root = recordOf(value, "sidecar", where);
  if (root.schemaVersion !== VOICE_REFERENCE_SCHEMA_VERSION) {
    throw invalid(where, `"schemaVersion" must be ${VOICE_REFERENCE_SCHEMA_VERSION}`);
  }
  const vendor = recordOf(root.vendor, "vendor", where);
  const format = recordOf(root.format, "format", where);
  const audio = recordOf(root.audio, "audio", where);
  const sha256 = text(audio.sha256, "audio.sha256", where);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw invalid(where, '"audio.sha256" must be 64 lowercase hex characters');
  }
  if (root.method !== "cascade-reference-render") {
    throw invalid(where, '"method" must be "cascade-reference-render"');
  }
  if (format.transport !== "browser") {
    throw invalid(where, '"format.transport" must be "browser"');
  }
  if (format.encoding !== "pcm_s16le") {
    throw invalid(where, '"format.encoding" must be "pcm_s16le"');
  }
  if (format.container !== "wav") {
    throw invalid(where, '"format.container" must be "wav"');
  }
  return {
    schemaVersion: VOICE_REFERENCE_SCHEMA_VERSION,
    voice: text(root.voice, "voice", where),
    locale: text(root.locale, "locale", where),
    line: text(root.line, "line", where),
    renderedOn: text(root.renderedOn, "renderedOn", where),
    producedBy: text(root.producedBy, "producedBy", where),
    method: "cascade-reference-render",
    vendor: {
      name: text(vendor.name, "vendor.name", where),
      voiceId: text(vendor.voiceId, "vendor.voiceId", where),
      model: text(vendor.model, "vendor.model", where),
    },
    format: {
      transport: "browser",
      container: "wav",
      encoding: "pcm_s16le",
      sampleRate: positiveInt(format.sampleRate, "format.sampleRate", where),
      channels: positiveInt(format.channels, "format.channels", where),
      bitsPerSample: positiveInt(format.bitsPerSample, "format.bitsPerSample", where),
    },
    audio: {
      file: text(audio.file, "audio.file", where),
      sha256,
      bytes: positiveInt(audio.bytes, "audio.bytes", where),
      durationMs: positiveNumber(audio.durationMs, "audio.durationMs", where),
    },
  };
}

/**
 * Load the one committed reference for a voice and Locale. The default pair is
 * the English demo; a caller may name another pair once its sidecar is
 * committed. A missing pair is a named refusal, never an English fallback.
 */
export function loadVoiceReference(
  voice: string = VOICE_REFERENCE_VOICE,
  locale: string = VOICE_REFERENCE_LOCALE,
  dir: string = VOICE_REFERENCE_DIR,
): VoiceReference {
  const sidecarPath = resolve(dir, `${voice}-${locale}.json`);
  const wavPath = resolve(dir, `${voice}-${locale}.wav`);
  if (!existsSync(sidecarPath)) {
    throw new VoiceReferenceError(
      "reference-missing",
      `voice reference missing: ${sidecarPath}. Commit one with \`${VOICE_REFERENCE_COMMAND}\`; ` +
        "A5 fails closed rather than borrowing another voice's audio.",
    );
  }
  if (!existsSync(wavPath)) {
    throw new VoiceReferenceError(
      "reference-missing",
      `voice reference audio missing: ${wavPath}. Commit the WAV beside ${sidecarPath}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch (error) {
    throw new VoiceReferenceError(
      "reference-sidecar-invalid",
      `cannot read voice reference sidecar ${sidecarPath}: ${String(error)}`,
    );
  }
  const provenance = parseVoiceReferenceSidecar(parsed, sidecarPath);
  if (provenance.voice !== voice || provenance.locale !== locale) {
    throw invalid(
      sidecarPath,
      `"voice"/"locale" are ${provenance.voice}/${provenance.locale}, not ${voice}/${locale}`,
    );
  }
  if (basename(provenance.audio.file) !== basename(wavPath)) {
    throw invalid(
      sidecarPath,
      `"audio.file" is ${provenance.audio.file}, not ${basename(wavPath)}`,
    );
  }

  const bytes = readFileSync(wavPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== provenance.audio.sha256) {
    throw new VoiceReferenceError(
      "reference-audio-mismatch",
      `voice reference ${wavPath}: sha256 ${actual} does not match the sidecar's ` +
        `${provenance.audio.sha256}; re-render rather than editing either file.`,
    );
  }

  let audio: DecodedAudio;
  try {
    audio = decodeWav(bytes);
  } catch (error) {
    const reason = error instanceof AudioFactsError ? error.message : String(error);
    throw new VoiceReferenceError(
      "reference-unreadable",
      `voice reference ${wavPath} is not a readable PCM16 WAV: ${reason}`,
    );
  }
  if (
    audio.facts.sampleRate !== provenance.format.sampleRate ||
    audio.facts.channels !== provenance.format.channels ||
    audio.facts.bitsPerSample !== provenance.format.bitsPerSample
  ) {
    throw new VoiceReferenceError(
      "reference-audio-mismatch",
      `voice reference ${wavPath} is ${audio.facts.sampleRate} Hz x${audio.facts.channels}ch ` +
        `${audio.facts.bitsPerSample}-bit, but the sidecar says ` +
        `${provenance.format.sampleRate} Hz x${provenance.format.channels}ch ` +
        `${provenance.format.bitsPerSample}-bit`,
    );
  }
  if (bytes.byteLength !== provenance.audio.bytes) {
    throw new VoiceReferenceError(
      "reference-audio-mismatch",
      `voice reference ${wavPath} is ${bytes.byteLength} bytes, but the sidecar says ` +
        `${provenance.audio.bytes}`,
    );
  }
  return {
    provenance,
    audio,
    path: wavPath,
    sidecarPath,
  };
}
