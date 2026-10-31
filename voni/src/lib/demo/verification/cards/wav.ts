/**
 * WAV duration, read from the file's own header.
 *
 * An audio excerpt may not trust a duration declared beside the evidence: the
 * card reads the WAV the excerpt names, finds its `fmt ` byte rate and `data`
 * size, and computes the span. A file that is not RIFF/WAVE, has no byte rate,
 * or claims a data chunk past its own end is refused by name — a truncated
 * capture is not evidence with a shorter duration.
 */

import { readFileSync } from "node:fs";

import { DefectCardError } from "./errors";

const RIFF = "RIFF";
const WAVE = "WAVE";
const FMT = "fmt ";
const DATA = "data";

function ascii(bytes: Buffer, at: number, length: number): string {
  return bytes.toString("ascii", at, at + length);
}

/** The file's exact duration in milliseconds. */
export function wavDurationMs(file: string): number {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new DefectCardError(
      "unreadable-wav",
      `cannot read excerpt media "${file}": ${(error as Error).message}`,
    );
  }

  if (bytes.length < 44 || ascii(bytes, 0, 4) !== RIFF || ascii(bytes, 8, 4) !== WAVE) {
    throw new DefectCardError(
      "unreadable-wav",
      `excerpt media "${file}" is not a RIFF/WAVE file`,
    );
  }

  let at = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = bytes.readUInt32LE(at + 4);
    const payload = at + 8;
    if (id === FMT) {
      if (size < 12 || payload + 12 > bytes.length) {
        throw new DefectCardError(
          "unreadable-wav",
          `excerpt media "${file}" has a truncated fmt chunk`,
        );
      }
      byteRate = bytes.readUInt32LE(payload + 8);
    } else if (id === DATA) {
      if (payload + size > bytes.length) {
        throw new DefectCardError(
          "unreadable-wav",
          `excerpt media "${file}" claims ${size} data bytes but only ` +
            `${bytes.length - payload} are present; a truncated capture is not evidence`,
        );
      }
      dataBytes = size;
      break;
    }
    at = payload + size + (size % 2);
  }

  if (byteRate <= 0) {
    throw new DefectCardError(
      "unreadable-wav",
      `excerpt media "${file}" has no usable byte rate`,
    );
  }
  if (dataBytes <= 0) {
    throw new DefectCardError(
      "unreadable-wav",
      `excerpt media "${file}" has no data chunk`,
    );
  }

  return (dataBytes / byteRate) * 1000;
}
