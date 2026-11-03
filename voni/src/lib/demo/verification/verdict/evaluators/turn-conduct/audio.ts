/**
 * The delivered WAV, read as samples.
 *
 * A certifying browser call's audio artifact is the playout worklet's rendered
 * output: mono 16-bit PCM at the device rate. This module turns it into the
 * only measurements the turn-taking and conduct evaluators may use — voiced
 * segments, their onsets and ends, and a content correlation for detecting a
 * doubled or restarted reply. It never trusts a declared duration beside the
 * file: a malformed or truncated WAV is refused by name.
 *
 * The detector is deliberately simple and deterministic: 20 ms frames on a
 * 10 ms hop, a noise floor read from the quietest fifth of the frames, a
 * threshold four times that floor (never below -48 dBFS), segments merged
 * across a gap shorter than 60 ms and shorter than 40 ms dropped. A tone, a
 * pause and a repeated burst are therefore the same three numbers in every
 * run, and a fixture can assert them exactly.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Turn-taking" T1–T10 and
 * "Conduct" C1–C10.
 */

import { readFileSync } from "node:fs";

import { TurnConductError } from "./errors";

/** One continuous voiced stretch of delivered audio. */
export type VoicedSegment = {
  readonly startMs: number;
  readonly endMs: number;
  readonly frames: number;
  readonly peak: number;
};

export type WavAnalysis = {
  readonly file: string;
  readonly sampleRate: number;
  readonly durationMs: number;
  readonly samples: Int16Array;
  readonly segments: readonly VoicedSegment[];
  readonly firstVoicedMs: number | null;
  readonly lastVoicedMs: number | null;
};

const FRAME_MS = 20;
const HOP_MS = 10;
const MERGE_GAP_MS = 60;
const MIN_SEGMENT_MS = 40;
/** Below -48 dBFS a frame is not speech; the worklet's silence is exactly 0. */
const MIN_RMS = 0.004;

function ascii(bytes: Buffer, at: number, length: number): string {
  return bytes.toString("ascii", at, at + length);
}

/** Read one RIFF/WAVE mono PCM16 file. Anything else is a named refusal. */
export function readWavPcm(file: string): {
  sampleRate: number;
  samples: Int16Array;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new TurnConductError(
      "unreadable-wav",
      `cannot read the delivered WAV at ${file}: ${(error as Error).message}`,
    );
  }
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new TurnConductError(
      "unreadable-wav",
      `the delivered audio at ${file} is not a RIFF/WAVE file`,
    );
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
        throw new TurnConductError(
          "unreadable-wav",
          `the delivered audio at ${file} has a truncated fmt chunk`,
        );
      }
      channels = bytes.readUInt16LE(payload + 2);
      sampleRate = bytes.readUInt32LE(payload + 4);
      bits = bytes.readUInt16LE(payload + 14);
    } else if (id === "data") {
      if (payload + size > bytes.length) {
        throw new TurnConductError(
          "unreadable-wav",
          `the delivered audio at ${file} claims ${size} data bytes but only ` +
            `${bytes.length - payload} are present; a truncated capture is not evidence`,
        );
      }
      data = bytes.subarray(payload, payload + size);
      break;
    }
    at = payload + size + (size % 2);
  }
  if (data === null || sampleRate <= 0) {
    throw new TurnConductError(
      "unreadable-wav",
      `the delivered audio at ${file} has no usable fmt or data chunk`,
    );
  }
  if (channels !== 1 || bits !== 16) {
    throw new TurnConductError(
      "unreadable-wav",
      `the delivered audio at ${file} is ${channels} channel(s), ${bits}-bit; ` +
        "the certifying capture is mono 16-bit PCM",
    );
  }
  const samples = new Int16Array(Math.floor(data.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2);
  }
  if (samples.length === 0) {
    throw new TurnConductError(
      "unreadable-wav",
      `the delivered audio at ${file} carries no samples`,
    );
  }
  return { sampleRate, samples };
}

function frameRms(samples: Int16Array, sampleRate: number): number[] {
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const values: number[] = [];
  for (let start = 0; start + frame <= samples.length; start += hop) {
    let sum = 0;
    let peak = 0;
    for (let index = start; index < start + frame; index += 1) {
      const value = samples[index]! / 32768;
      sum += value * value;
      const absolute = Math.abs(value);
      if (absolute > peak) peak = absolute;
    }
    values.push(Math.sqrt(sum / frame));
  }
  return values;
}

/** A floor above this is speech, not room tone: the absolute threshold then rules. */
const MAX_RELATIVE_THRESHOLD = 0.02;

function noiseFloor(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const quietest = Math.max(1, Math.floor(sorted.length * 0.2));
  return sorted[quietest - 1] ?? 0;
}

/** Analyse one delivered WAV into its voiced stretches. */
export function analyseWav(file: string): WavAnalysis {
  const { sampleRate, samples } = readWavPcm(file);
  const rms = frameRms(samples, sampleRate);
  const threshold = Math.max(
    MIN_RMS,
    Math.min(noiseFloor(rms) * 4, MAX_RELATIVE_THRESHOLD),
  );
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));

  const segments: VoicedSegment[] = [];
  let startFrame: number | null = null;
  let lastVoicedFrame = -1;
  let peak = 0;

  const flush = () => {
    if (startFrame === null) return;
    const startMs = (startFrame * hop * 1000) / sampleRate;
    const endMs = ((lastVoicedFrame * hop + frame) * 1000) / sampleRate;
    if (endMs - startMs >= MIN_SEGMENT_MS) {
      segments.push({
        startMs,
        endMs,
        frames: Math.round(((endMs - startMs) / 1000) * sampleRate),
        peak,
      });
    }
    startFrame = null;
    peak = 0;
  };

  for (const [index, value] of rms.entries()) {
    if (value >= threshold) {
      if (startFrame === null) {
        startFrame = index;
        peak = 0;
      } else if ((index - lastVoicedFrame) * HOP_MS > MERGE_GAP_MS) {
        // A long pause splits two utterances; the segment ends before the gap.
        flush();
        startFrame = index;
      }
      lastVoicedFrame = index;
      const frameStart = Math.floor((index * hop) / sampleRate);
      const frameEnd = Math.min(samples.length, frameStart + frame);
      for (let at = frameStart; at < frameEnd; at += 1) {
        const absolute = Math.abs(samples[at]! / 32768);
        if (absolute > peak) peak = absolute;
      }
    }
  }
  flush();

  const durationMs = (samples.length / sampleRate) * 1000;
  return {
    file,
    sampleRate,
    durationMs,
    samples,
    segments,
    firstVoicedMs: segments.length === 0 ? null : segments[0]!.startMs,
    lastVoicedMs: segments.length === 0 ? null : segments[segments.length - 1]!.endMs,
  };
}

/** The segment's samples, normalised to [-1, 1]. */
export function segmentPcm(analysis: WavAnalysis, segment: VoicedSegment): Float32Array {
  const from = Math.max(0, Math.floor((segment.startMs / 1000) * analysis.sampleRate));
  const to = Math.min(
    analysis.samples.length,
    Math.ceil((segment.endMs / 1000) * analysis.sampleRate),
  );
  const out = new Float32Array(Math.max(0, to - from));
  for (let index = from; index < to; index += 1) {
    out[index - from] = analysis.samples[index]! / 32768;
  }
  return out;
}

/**
 * Amplitude- and DC-invariant correlation of two segments at zero lag. A
 * repeated reply scores near 1; a different tone or a resumed tail scores low.
 */
export function correlation(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < length; index += 1) {
    leftMean += left[index]!;
    rightMean += right[index]!;
  }
  leftMean /= length;
  rightMean /= length;
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index]! - leftMean;
    const b = right[index]! - rightMean;
    numerator += a * b;
    leftEnergy += a * a;
    rightEnergy += b * b;
  }
  if (leftEnergy === 0 || rightEnergy === 0) return 0;
  return numerator / Math.sqrt(leftEnergy * rightEnergy);
}

/** The first `ms` of a segment, for prefix comparisons. */
export function prefix(
  analysis: WavAnalysis,
  segment: VoicedSegment,
  ms: number,
): Float32Array {
  const pcm = segmentPcm(analysis, segment);
  const count = Math.min(pcm.length, Math.round((ms / 1000) * analysis.sampleRate));
  return pcm.subarray(0, count);
}

/**
 * A segment's content fingerprint: the short-time energy envelope and the
 * zero-crossing rate over its first `ms`. Two replays of the same synthesized
 * line share both; two different words share neither. Phase is deliberately
 * discarded — a segment boundary is a frame edge, never a sample-exact replay.
 */
export type SegmentSignature = {
  readonly envelope: readonly number[];
  readonly zeroCrossings: number;
  readonly ms: number;
};

const SIGNATURE_WINDOW_MS = 10;

export function signature(
  analysis: WavAnalysis,
  segment: VoicedSegment,
  ms = 700,
): SegmentSignature {
  const pcm = prefix(analysis, segment, ms);
  const window = Math.max(1, Math.round((SIGNATURE_WINDOW_MS / 1000) * analysis.sampleRate));
  const envelope: number[] = [];
  let crossings = 0;
  for (let start = 0; start < pcm.length; start += window) {
    let sum = 0;
    let previous = pcm[start] ?? 0;
    for (let index = start; index < Math.min(start + window, pcm.length); index += 1) {
      const value = pcm[index]!;
      sum += value * value;
      if ((value >= 0 && previous < 0) || (value < 0 && previous >= 0)) crossings += 1;
      previous = value;
    }
    envelope.push(Math.sqrt(sum / Math.max(1, Math.min(window, pcm.length - start))));
  }
  const peak = Math.max(...envelope, 0);
  const normalized = peak === 0 ? envelope : envelope.map((value) => value / peak);
  // A segment boundary is a frame edge: drop the partial edge windows so a
  // flat envelope compares as flat instead of as a shifted zero.
  let from = 0;
  let to = normalized.length;
  while (from < to && normalized[from]! < 0.05) from += 1;
  while (to > from && normalized[to - 1]! < 0.05) to -= 1;
  return {
    envelope: normalized.slice(from, to),
    zeroCrossings: pcm.length === 0 ? 0 : (crossings / pcm.length) * analysis.sampleRate,
    ms: (pcm.length / analysis.sampleRate) * 1000,
  };
}

function envelopeCorrelation(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  const mean = (values: readonly number[]) =>
    values.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index]! - leftMean;
    const b = right[index]! - rightMean;
    numerator += a * b;
    leftEnergy += a * a;
    rightEnergy += b * b;
  }
  if (leftEnergy === 0 && rightEnergy === 0) {
    // Two flat envelopes with the same level are the same shape.
    return Math.abs(leftMean - rightMean) < 0.05 ? 1 : 0;
  }
  if (leftEnergy === 0 || rightEnergy === 0) return 0;
  const value = numerator / Math.sqrt(leftEnergy * rightEnergy);
  return Math.max(0, Math.min(1, value));
}

/**
 * How alike two segments are, 0–1. The envelope decides rhythm, the
 * zero-crossing rate decides timbre: a replay scores near 1, a resumed tail or
 * a different tone does not. The shorter fingerprint wins, so a 300 ms ack can
 * never look like a 700 ms sentence.
 */
export function similarity(left: SegmentSignature, right: SegmentSignature): number {
  const envelope = envelopeCorrelation(left.envelope, right.envelope);
  const loudest = Math.max(left.zeroCrossings, right.zeroCrossings);
  const crossings =
    loudest === 0 ? 1 : 1 - Math.abs(left.zeroCrossings - right.zeroCrossings) / loudest;
  const lengthRatio =
    Math.min(left.ms, right.ms) / Math.max(left.ms, right.ms);
  return envelope * Math.max(0, crossings) * lengthRatio;
}
