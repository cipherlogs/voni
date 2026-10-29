/**
 * Load the two measured captures the timbre gate compares.
 *
 * The gate's measured result (`timbre-measurement.ts`) is pure: decoded audio
 * in, measurements out. This module is the one place the command-line side
 * turns two saved files into that input, so a real run with a Delivered WAV
 * can earn the timbre gate instead of reporting INFO forever. A file that
 * cannot be read is a named error before any artifact is opened: the run does
 * not get to write a score from a capture nobody could measure.
 */
import { decodeAudioFile } from "../audio/format-facts";
import type { MeasuredLevelFile, MeasuredLevelInput } from "./timbre-measurement";

/** A capture argument that cannot be read as audio, named by its flag. */
export class MeasuredCaptureError extends Error {
  constructor(
    readonly role: "reference" | "delivered",
    readonly path: string,
    message: string,
  ) {
    super(`${role} capture unreadable: ${path}: ${message}`);
    this.name = "MeasuredCaptureError";
  }
}

/** Read one capture through the shared decoder; never guess a format. */
export function readMeasuredCapture(
  role: "reference" | "delivered",
  path: string,
): MeasuredLevelFile {
  try {
    return { path, audio: decodeAudioFile(path) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MeasuredCaptureError(role, path, reason);
  }
}

/**
 * Build the measured level input from `--reference <wav>` and
 * `--delivered <wav>`. Both are required together: one side alone is a named
 * error, because a half pair is not a measurement the gate can judge.
 */
export function readMeasuredLevelInput(
  paths: { reference?: string; delivered?: string },
): MeasuredLevelInput | undefined {
  const reference = paths.reference?.trim() ?? "";
  const delivered = paths.delivered?.trim() ?? "";
  if (!reference && !delivered) return undefined;
  if (!reference) {
    throw new Error("--reference <wav> is required with --delivered (a half pair is not a measurement)");
  }
  if (!delivered) {
    throw new Error("--delivered <wav> is required with --reference (a half pair is not a measurement)");
  }
  return {
    reference: readMeasuredCapture("reference", reference),
    delivered: readMeasuredCapture("delivered", delivered),
  };
}
