/**
 * Capture evidence: a capture is recorded by reference, never by value
 * (meta-cascade M4/W0, ticket 126).
 *
 * The artifact carries one record per capture leg — the gitignored working
 * file's path and its sha256 — and never the samples themselves. Audio in
 * machine-readable evidence is a leak and an unverifiable claim at once: bytes
 * cannot be re-measured, and a hash can.
 *
 * Two rules follow from that and live here:
 *
 * - **Recording is hashing.** {@link captureEvidence} reads a capture only to
 *   compute its sha256. A missing, empty or unreadable file is a named
 *   {@link CaptureEvidenceError}, never an empty record.
 * - **A record claims, a file proves.** {@link verifyCaptureRecord} re-reads the
 *   file the record names. A file that is gone makes the claim *missing*, a file
 *   whose bytes changed makes it *dirty*, and a record that smuggles audio bytes
 *   (or omits the hash) is *malformed*. Only a matching hash is *verified*.
 *
 * The verifier takes its reader from the caller ({@link CaptureIO}) so a test
 * never touches a real capture directory, and the default is the filesystem.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ArtifactCaptureLeg } from "./scoreboard";

/** A capture a gate's PASS rests on, by leg (spec M3/W0). */
export const GATE_CAPTURE_LEGS: Readonly<Record<string, readonly ArtifactCaptureLeg[]>> = {
  "timbre-probes": ["reference", "delivered"],
};

/** A recorded capture: the file it names and the hash its bytes must have. */
export type CaptureRecord = { readonly path: string; readonly sha256: string };

/** Why a capture cannot be recorded. Each code blocks a claim by name. */
export type CaptureEvidenceErrorCode =
  | "capture-missing"
  | "capture-empty"
  | "capture-unreadable";

/** A refused capture. A caller can branch on `code`; nothing is defaulted. */
export class CaptureEvidenceError extends Error {
  constructor(
    readonly code: CaptureEvidenceErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "CaptureEvidenceError";
  }
}

/**
 * The field names that mean "here is the audio itself". A capture record may
 * carry a path and a hash; any of these is a captured byte payload in the
 * artifact, refused wherever it appears.
 */
export const AUDIO_BYTES_FIELDS = [
  "audio",
  "base64",
  "bytes",
  "data",
  "pcm",
  "samples",
  "waveform",
  "wav",
] as const;

/** A record that names a file and hashes it; the bytes stay on disk. */
export function captureEvidence(path: string): CaptureRecord {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code: CaptureEvidenceErrorCode =
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "capture-missing" : "capture-unreadable";
    throw new CaptureEvidenceError(
      code,
      path,
      `capture ${code === "capture-missing" ? "missing" : "unreadable"}: ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}. A capture is a working file; ` +
        "record it after it has been written.",
    );
  }
  if (bytes.byteLength === 0) {
    throw new CaptureEvidenceError(
      "capture-empty",
      path,
      `capture empty: ${path}: zero bytes, so there is no audio to hash or measure.`,
    );
  }
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** A capture a caller can re-read: bytes for a path, or a named failure. */
export type CaptureIO = {
  /** Read the file, or return null when it is not there. */
  readonly read?: (path: string) => Buffer | null;
};

function defaultRead(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * The state of a recorded capture: its file is present and matches the hash
 * (`verified`), the file is absent (`missing`), the bytes changed (`dirty`), or
 * the record itself is not a path-and-hash (`malformed`).
 */
export type CaptureVerification = {
  status: "verified" | "missing" | "dirty" | "malformed";
  /** The record's path, when the record names one. */
  path: string | null;
  /** The reason a non-verified capture cannot support a claim. */
  reason: string | null;
};

/** A path is not a URL and not a data URI: a capture is a file on disk. */
function isCapturePath(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !value.startsWith("data:");
}

function isCaptureHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Why a record is not a path-and-hash, or null when it is one. Shared by the
 * verifier and the artifact reader, so a record that smuggles audio bytes is
 * refused with the same sentence at both seams.
 */
export function malformedCaptureReason(
  raw: unknown,
): { path: string | null; reason: string } | null {
  const path =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).path
      : undefined;

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      path: null,
      reason: `capture record is not an object (${JSON.stringify(raw ?? null)}); a leg names {path, sha256}`,
    };
  }
  const record = raw as Record<string, unknown>;
  const smuggle = AUDIO_BYTES_FIELDS.filter((field) => record[field] !== undefined);
  if (smuggle.length > 0) {
    return {
      path: isCapturePath(path) ? path : null,
      reason:
        `capture record carries ${smuggle.join(", ")}; the artifact records a path and a hash, ` +
        "never audio bytes (the WAV is a gitignored working file)",
    };
  }
  if (!isCapturePath(path)) {
    return {
      path: null,
      reason: `capture record names no file path (${JSON.stringify(path)}); a record is {path, sha256}`,
    };
  }
  if (!isCaptureHash(record.sha256)) {
    return {
      path,
      reason:
        `capture ${path} carries no sha256 (${JSON.stringify(record.sha256 ?? null)}); ` +
        "64 lowercase hex characters are required",
    };
  }
  return null;
}

/**
 * Re-prove one recorded capture against its working file. A record that embeds
 * audio, names no file, or carries a hash that is not a sha256 is malformed; a
 * record whose file is gone is missing; a record whose bytes changed is dirty.
 */
export function verifyCaptureRecord(
  raw: unknown,
  io: CaptureIO = {},
): CaptureVerification {
  const malformed = malformedCaptureReason(raw);
  if (malformed !== null) {
    return { status: "malformed", path: malformed.path, reason: malformed.reason };
  }
  const record = raw as CaptureRecord;
  const { path } = record;

  const bytes = (io.read ?? defaultRead)(path);
  if (bytes === null) {
    return {
      status: "missing",
      path,
      reason:
        `capture ${path} is not on disk, so the claim cannot be re-proved; ` +
        "a missing capture is unresolved, never verified",
    };
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== record.sha256) {
    return {
      status: "dirty",
      path,
      reason:
        `capture ${path} is dirty: its sha256 ${actual} does not match the recorded ${record.sha256}; ` +
        "the file is not the capture the claim names",
    };
  }
  return { status: "verified", path, reason: null };
}
