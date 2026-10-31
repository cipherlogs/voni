/**
 * Delivered-WAV analysis for the lifecycle family.
 *
 * L7 ("one human breath") and L9 ("a started goodbye is fully audible") are
 * judged from the audio the playout worklet actually rendered, never from a
 * queued frame or a declared duration. The module reads the WAV's own RIFF
 * header, measures speech in short frames, merges pauses that belong inside a
 * breath, and refuses a malformed or non-PCM16-mono capture by name.
 *
 * Spec: `.scratch/demo-verification/spec.md`, L7 and L9.
 */

import { readFileSync } from "node:fs";

export const LIFE_WAV_ERROR_CODES = [
  "wav-missing",
  "wav-malformed",
  "wav-empty",
] as const;

export type LifeWavErrorCode = (typeof LIFE_WAV_ERROR_CODES)[number];

export class LifeWavError extends Error {
  readonly code: LifeWavErrorCode;

  constructor(code: LifeWavErrorCode, message: string) {
    super(message);
    this.name = "LifeWavError";
    this.code = code;
  }
}

/** One contiguous stretch of speech, in call-relative milliseconds. */
export type SpeechSegment = {
  readonly startMs: number;
  readonly endMs: number;
};

export type WavAnalysis = {
  readonly sampleRate: number;
  readonly durationMs: number;
  readonly segments: readonly SpeechSegment[];
  /** First speech sample's time; null when the file carries no speech. */
  readonly firstSpeechMs: number | null;
  /** Last speech sample's time; null when the file carries no speech. */
  readonly lastSpeechEndMs: number | null;
  /** Silence between the last speech sample and the file's end. */
  readonly trailingSilenceMs: number | null;
};

/** 20 ms frames: long enough to smooth a waveform, short enough for a stop. */
const FRAME_MS = 20;
/** A frame is speech when any sample crosses 2% of full scale (−34 dBFS). */
const SPEECH_AMPLITUDE = 0.02 * 32767;
/** Pauses shorter than this stay inside one breath. */
const BREATH_GAP_MS = 300;
/** A gap at least this long starts a new turn, not another clause. */
const TURN_GAP_MS = 1_200;

function ascii(bytes: Buffer, at: number, length: number): string {
  return bytes.toString("ascii", at, at + length);
}

function readPcm16Mono(file: string): { sampleRate: number; samples: Int16Array } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new LifeWavError(
      "wav-missing",
      `cannot read the delivered capture at ${file}: ${(error as Error).message}`,
    );
  }
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new LifeWavError("wav-malformed", `the delivered capture at ${file} is not RIFF/WAVE`);
  }
  let at = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = bytes.readUInt32LE(at + 4);
    const payload = at + 8;
    if (id === "fmt ") {
      if (size < 16 || payload + 16 > bytes.length) {
        throw new LifeWavError("wav-malformed", `the capture at ${file} has a truncated fmt chunk`);
      }
      channels = bytes.readUInt16LE(payload + 2);
      sampleRate = bytes.readUInt32LE(payload + 4);
      bits = bytes.readUInt16LE(payload + 14);
    } else if (id === "data") {
      if (payload + size > bytes.length) {
        throw new LifeWavError(
          "wav-malformed",
          `the capture at ${file} claims ${size} data bytes but only ${bytes.length - payload} exist`,
        );
      }
      data = bytes.subarray(payload, payload + size);
      break;
    }
    at = payload + size + (size % 2);
  }
  if (data === null || sampleRate <= 0) {
    throw new LifeWavError("wav-malformed", `the capture at ${file} has no usable data chunk`);
  }
  if (channels !== 1 || bits !== 16) {
    throw new LifeWavError(
      "wav-malformed",
      `the capture at ${file} is ${channels} channel(s), ${bits}-bit; the certifying capture is mono 16-bit PCM`,
    );
  }
  if (data.length === 0) {
    throw new LifeWavError("wav-empty", `the capture at ${file} carries no samples`);
  }
  const samples = new Int16Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2);
  }
  return { sampleRate, samples };
}

/** Frame-level speech runs, merged across pauses shorter than a breath. */
export function speechSegments(
  samples: Int16Array,
  sampleRate: number,
): SpeechSegment[] {
  const frameSamples = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const segments: { startMs: number; endMs: number }[] = [];
  let current: { startMs: number; endMs: number } | null = null;
  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    let speech = false;
    for (let index = start; index < end; index += 1) {
      if (Math.abs(samples[index] ?? 0) >= SPEECH_AMPLITUDE) {
        speech = true;
        break;
      }
    }
    if (!speech) continue;
    const startMs = (start / sampleRate) * 1000;
    const endMs = (end / sampleRate) * 1000;
    if (current === null) {
      current = { startMs, endMs };
      continue;
    }
    if (startMs - current.endMs < BREATH_GAP_MS) {
      current = { startMs: current.startMs, endMs };
      continue;
    }
    segments.push(current);
    current = { startMs, endMs };
  }
  if (current !== null) segments.push(current);
  return segments;
}

/** Read the capture and measure what the visitor heard. */
export function analyseWav(file: string): WavAnalysis {
  const { sampleRate, samples } = readPcm16Mono(file);
  const durationMs = (samples.length / sampleRate) * 1000;
  const segments = speechSegments(samples, sampleRate);
  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    sampleRate,
    durationMs,
    segments,
    firstSpeechMs: first?.startMs ?? null,
    lastSpeechEndMs: last?.endMs ?? null,
    trailingSilenceMs: last === undefined ? null : Math.max(0, durationMs - last.endMs),
  };
}

/**
 * The longest continuous speech run in the opening window. The greeting ends
 * at the first gap long enough to be a new turn; a call with no turn gap keeps
 * its whole speech span. A natural split is a gap of at least `BREATH_GAP_MS`,
 * so each clause is measured on its own breath.
 */
export function openingSpeechRuns(analysis: WavAnalysis): number[] {
  const segments = analysis.segments;
  if (segments.length === 0) return [];
  const runs: number[] = [];
  let previousEnd = segments[0]?.endMs ?? 0;
  for (const segment of segments) {
    const gap = segment.startMs - previousEnd;
    if (runs.length > 0 && gap >= TURN_GAP_MS) break;
    runs.push(segment.endMs - segment.startMs);
    previousEnd = segment.endMs;
  }
  return runs;
}

/** The last speech run, which is the goodbye on an ending call. */
export function lastSpeechRunMs(analysis: WavAnalysis): number | null {
  const last = analysis.segments[analysis.segments.length - 1];
  return last === undefined ? null : last.endMs - last.startMs;
}

/** How much of the last speech run is followed by silence. */
export function trailingSilenceOfLastRun(analysis: WavAnalysis): number | null {
  return analysis.trailingSilenceMs;
}
