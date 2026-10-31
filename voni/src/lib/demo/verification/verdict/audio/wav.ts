/**
 * The delivered WAV evidence reader.
 *
 * A1–A8 read the audio the caller actually received, never the vendor stream
 * and never a path the call's own trace does not name. The browser adapter
 * writes one PCM16 mono WAV and a declared description of it; this reader
 * decodes the file and refuses a description that disagrees with the bytes.
 * An unreadable or misdescribed capture is a named refusal before any verdict:
 * a file that is not what the evidence claims cannot be judged.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AudioFactsError,
  decodeWav,
  type DecodedAudio,
} from "@/lib/audio/format-facts";

/** The one shape the browser adapter's `wav` source carries. */
export type DeliveredWavEvidence = {
  readonly file: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly frames: number;
  readonly durationMs: number;
  readonly bytes: number;
};

/** The browser artifact beside the WAV; it must cite the same capture. */
export type BrowserCaptureEvidence = {
  readonly capture?: {
    readonly file?: unknown;
    readonly bytes?: unknown;
    readonly sampleRate?: unknown;
    readonly seconds?: unknown;
  };
};

export type AudioEvidenceErrorCode =
  | "wav-missing"
  | "wav-unreadable"
  | "wav-format"
  | "wav-empty"
  | "wav-misdescribed"
  | "browser-capture-mismatch";

/** A refused delivered capture. A caller can branch on `code`. */
export class AudioEvidenceError extends Error {
  constructor(
    readonly code: AudioEvidenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AudioEvidenceError";
  }
}

export type DeliveredCapture = {
  readonly file: string;
  readonly audio: DecodedAudio;
  readonly bytes: number;
  readonly declared: DeliveredWavEvidence;
};

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AudioEvidenceError("wav-misdescribed", `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function numberField(
  record: Record<string, unknown>,
  field: string,
  code: AudioEvidenceErrorCode,
  where: string,
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AudioEvidenceError(
      code,
      `the delivered capture description at ${where} has no finite "${field}"`,
    );
  }
  return value;
}

/** Read, decode and cross-check one delivered capture. */
export function readDeliveredCapture(
  source: unknown,
  browser?: unknown,
): DeliveredCapture {
  const declaredRecord = recordOf(source, "the wav evidence");
  const file = declaredRecord.file;
  if (typeof file !== "string" || file.trim() === "") {
    throw new AudioEvidenceError(
      "wav-missing",
      "the wav evidence names no delivered capture file; A1-A8 have nothing to read",
    );
  }
  if (!existsSync(file)) {
    throw new AudioEvidenceError(
      "wav-missing",
      `the delivered capture ${file} does not exist; the browser adapter's WAV sink did not write it`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new AudioEvidenceError(
      "wav-unreadable",
      `cannot read the delivered capture ${file}: ${(error as Error).message}`,
    );
  }
  if (bytes.byteLength === 0) {
    throw new AudioEvidenceError(
      "wav-unreadable",
      `the delivered capture ${file} is zero bytes; an empty file is not a short capture`,
    );
  }

  let audio: DecodedAudio;
  try {
    audio = decodeWav(bytes);
  } catch (error) {
    const reason = error instanceof AudioFactsError ? error.message : String(error);
    throw new AudioEvidenceError(
      "wav-unreadable",
      `the delivered capture ${file} is not a readable PCM16 WAV: ${reason}`,
    );
  }

  const facts = audio.facts;
  if (facts.frameCount === 0 || audio.samples.length === 0) {
    throw new AudioEvidenceError(
      "wav-empty",
      `the delivered capture ${file} has a header and no sample frames`,
    );
  }
  if (facts.channels !== 1 || facts.bitsPerSample !== 16) {
    throw new AudioEvidenceError(
      "wav-format",
      `the delivered capture ${file} is ${facts.channels} channel(s), ${facts.bitsPerSample}-bit; ` +
        "the capture contract is mono 16-bit PCM",
    );
  }

  const declared: DeliveredWavEvidence = {
    file,
    sampleRate: numberField(declaredRecord, "sampleRate", "wav-misdescribed", file),
    channels: numberField(declaredRecord, "channels", "wav-misdescribed", file),
    bitsPerSample: numberField(declaredRecord, "bitsPerSample", "wav-misdescribed", file),
    frames: numberField(declaredRecord, "frames", "wav-misdescribed", file),
    durationMs: numberField(declaredRecord, "durationMs", "wav-misdescribed", file),
    bytes: numberField(declaredRecord, "bytes", "wav-misdescribed", file),
  };

  const problems: string[] = [];
  if (declared.sampleRate !== facts.sampleRate) {
    problems.push(`the description says ${declared.sampleRate} Hz, the file is ${facts.sampleRate} Hz`);
  }
  if (declared.channels !== facts.channels) {
    problems.push(`the description says ${declared.channels} channel(s), the file has ${facts.channels}`);
  }
  if (declared.bitsPerSample !== facts.bitsPerSample) {
    problems.push(
      `the description says ${declared.bitsPerSample}-bit, the file is ${facts.bitsPerSample}-bit`,
    );
  }
  if (declared.frames !== facts.frameCount) {
    problems.push(`the description says ${declared.frames} frames, the file has ${facts.frameCount}`);
  }
  if (Math.abs(declared.durationMs - facts.durationSeconds * 1000) > 1) {
    problems.push(
      `the description says ${declared.durationMs} ms, the file is ` +
        `${(facts.durationSeconds * 1000).toFixed(1)} ms`,
    );
  }
  if (declared.bytes !== bytes.byteLength) {
    problems.push(`the description says ${declared.bytes} bytes, the file is ${bytes.byteLength}`);
  }
  if (problems.length > 0) {
    throw new AudioEvidenceError(
      "wav-misdescribed",
      `the delivered capture ${file} is misdescribed: ${problems.join("; ")}`,
    );
  }

  if (browser !== undefined && browser !== null) {
    const browserRecord = recordOf(browser, "the browser evidence");
    const capture = browserRecord.capture;
    if (capture !== undefined && capture !== null) {
      const captureRecord = recordOf(capture, "the browser capture evidence");
      const captureFile = captureRecord.file;
      if (typeof captureFile !== "string" || resolve(captureFile) !== resolve(file)) {
        throw new AudioEvidenceError(
          "browser-capture-mismatch",
          `the browser capture cites ${String(captureFile)}, but the wav evidence is ${file}; ` +
            "one call has one delivered capture",
        );
      }
      if (
        typeof captureRecord.bytes === "number" &&
        captureRecord.bytes !== bytes.byteLength
      ) {
        throw new AudioEvidenceError(
          "browser-capture-mismatch",
          `the browser capture says ${captureRecord.bytes} bytes, the WAV is ${bytes.byteLength}`,
        );
      }
      if (
        typeof captureRecord.sampleRate === "number" &&
        captureRecord.sampleRate !== facts.sampleRate
      ) {
        throw new AudioEvidenceError(
          "browser-capture-mismatch",
          `the browser capture says ${captureRecord.sampleRate} Hz, the WAV is ${facts.sampleRate} Hz`,
        );
      }
      if (
        typeof captureRecord.seconds === "number" &&
        Math.abs(captureRecord.seconds * 1000 - facts.durationSeconds * 1000) > 2
      ) {
        throw new AudioEvidenceError(
          "browser-capture-mismatch",
          `the browser capture says ${captureRecord.seconds}s, the WAV is ` +
            `${facts.durationSeconds.toFixed(3)}s`,
        );
      }
    }
  }

  return { file, audio, bytes: bytes.byteLength, declared };
}
