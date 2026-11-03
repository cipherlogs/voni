/**
 * The audio analyser: delivered PCM in, measured defects out.
 *
 * These are the measurements A1, A6, A7 and A8 judge. They are pure over a
 * decoded file, so a saved capture can be re-analysed without a browser, a
 * socket or the vendor stream. Every event carries the time range it occupies,
 * because a failure without a pointer is incomplete triage.
 *
 * The detector bars are not invented here:
 *
 * - a dropout is a breakup the existing `breakups` analyser names and that
 *   lasts longer than 20 ms (A1's own bar);
 * - a click is an adjacent output jump above the playout worklet's own
 *   `POP_JUMP` (0.3 of full scale), the rule the client already uses to name
 *   the click it is about to play;
 * - an overrun is a run of full-scale samples: the device's overload, recorded
 *   by the capture's own clamp;
 * - a fade is a monotonic speech-to-digital-silence ramp, the shape a flush
 *   leaves;
 * - a silent frame against the reference is a frame the reference speaks and
 *   the delivered capture does not.
 */

import { detectBreakups } from "@/lib/audio/breakups";
import type { DecodedAudio } from "@/lib/audio/format-facts";

const FULL_SCALE = 32_768;

/** The playout worklet's click rule (`public/playout-processor.js`, POP_JUMP). */
export const CLICK_JUMP = 0.3;

/** Two jumps this close are one click, not two. */
const CLICK_DEBOUNCE_MS = 5;

const ENVELOPE_FRAME_MS = 10;
const SILENCE_FLOOR_DBFS = -60;
/** A fade ends at digital silence, not at the audible floor: the ramp below
 * -60 dBFS is still the fade the caller hears as a fade, not a cut. */
const DIGITAL_SILENCE_FLOOR_DBFS = -90;
/** A frame above this is speech, not the tail of a decay. */
const SPEECH_FLOOR_DBFS = -40;

export type AudioEvent = {
  /** Offset from the start of the file, in milliseconds. */
  readonly atMs: number;
  /** Occupied span; 0 for an instantaneous event. */
  readonly durationMs: number;
};

export type EventReport = {
  readonly events: readonly AudioEvent[];
  readonly count: number;
  readonly longestMs: number;
};

export type SilentFrameReport = {
  readonly frameMs: number;
  /** Frames the reference speaks and the delivered capture leaves silent. */
  readonly count: number;
  readonly windows: readonly AudioEvent[];
};

/** An input the analyser cannot compare frame-for-frame. */
export class AudioAnalysisError extends Error {
  constructor(
    readonly code: "format-mismatch" | "empty-audio",
    message: string,
  ) {
    super(message);
    this.name = "AudioAnalysisError";
  }
}

function factsOf(audio: DecodedAudio): { sampleRate: number; channels: number; frameCount: number } {
  const { sampleRate, channels, frameCount } = audio.facts;
  if (frameCount <= 0 || audio.samples.length === 0) {
    throw new AudioAnalysisError("empty-audio", "the decoded file carries no sample frames");
  }
  return { sampleRate, channels, frameCount };
}

/** Mean-square level of every non-overlapping frame, in dBFS. */
export function frameLevelsDb(audio: DecodedAudio, frameMs = ENVELOPE_FRAME_MS): number[] {
  const { sampleRate, channels, frameCount } = factsOf(audio);
  const frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.ceil(frameCount / frameSamples);
  const levels = new Array<number>(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const first = frame * frameSamples;
    const last = Math.min(first + frameSamples, frameCount);
    let sumSquares = 0;
    for (let index = first; index < last; index += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = audio.samples[index * channels + channel]! / FULL_SCALE;
        sumSquares += sample * sample;
      }
    }
    const count = Math.max(1, (last - first) * channels);
    levels[frame] = 10 * Math.log10(sumSquares / count);
  }
  return levels;
}

/**
 * A dropout is a hole the breakup analyser names, longer than 20 ms. The 20 ms
 * bar is A1's own; a 20 ms hole is the allowed floor, not a dropout.
 */
export function detectDropouts(audio: DecodedAudio): EventReport {
  const report = detectBreakups(audio, { minBreakupMs: 20 });
  const events = report.breakups
    .filter((breakup) => breakup.durationSeconds * 1000 > 20)
    .map((breakup) => ({
      atMs: Math.round(breakup.startSeconds * 1000),
      durationMs: Math.round(breakup.durationSeconds * 1000),
    }));
  return {
    events,
    count: events.length,
    longestMs: events.reduce((longest, event) => Math.max(longest, event.durationMs), 0),
  };
}

/**
 * The first non-zero sample. The delivered capture is the worklet's rendered
 * output, and an idle playout renders digital zero, so this is the first sample
 * of the first utterance — more precise than the speech floor, which a soft
 * word attack crosses 50 ms late.
 */
export function firstNonSilentMs(audio: DecodedAudio): number | null {
  const { channels, sampleRate } = audio.facts;
  for (let frame = 0; frame < audio.facts.frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      if ((audio.samples[frame * channels + channel] ?? 0) !== 0) {
        return (frame / sampleRate) * 1000;
      }
    }
  }
  return null;
}

/**
 * A click (or a seam) is one adjacent output jump above the worklet's own
 * POP_JUMP, debounced so the up and down edges of one impulse are one event.
 */
export function detectClicks(audio: DecodedAudio): EventReport {
  const { sampleRate, channels, frameCount } = factsOf(audio);
  const events: AudioEvent[] = [];
  let lastAtMs = -Infinity;
  for (let frame = 1; frame < frameCount; frame += 1) {
    const now = audio.samples[frame * channels]!;
    const before = audio.samples[(frame - 1) * channels]!;
    const jump = Math.abs(now - before) / FULL_SCALE;
    if (jump <= CLICK_JUMP) continue;
    const atMs = Math.round((frame / sampleRate) * 1000);
    if (atMs - lastAtMs < CLICK_DEBOUNCE_MS) continue;
    events.push({ atMs, durationMs: 0 });
    lastAtMs = atMs;
  }
  return {
    events,
    count: events.length,
    longestMs: events.reduce((longest, event) => Math.max(longest, event.durationMs), 0),
  };
}

/** A run of full-scale samples: the device overload the capture recorded. */
export function detectClippedRuns(audio: DecodedAudio, minSamples = 2): EventReport {
  const { sampleRate, channels, frameCount } = factsOf(audio);
  const events: AudioEvent[] = [];
  let frame = 0;
  while (frame < frameCount) {
    const sample = Math.abs(audio.samples[frame * channels]!);
    if (sample < FULL_SCALE - 1) {
      frame += 1;
      continue;
    }
    const start = frame;
    while (
      frame < frameCount &&
      Math.abs(audio.samples[frame * channels]!) >= FULL_SCALE - 1
    ) {
      frame += 1;
    }
    if (frame - start < minSamples) continue;
    events.push({
      atMs: Math.round((start / sampleRate) * 1000),
      durationMs: Math.round(((frame - start) / sampleRate) * 1000),
    });
  }
  return {
    events,
    count: events.length,
    longestMs: events.reduce((longest, event) => Math.max(longest, event.durationMs), 0),
  };
}

/**
 * Every speech-to-silence ramp in the file. The walk starts where the silent
 * run begins and climbs back over a level that never rises by more than the
 * one-frame tolerance, so an ordinary amplitude swing is not a fade.
 */
export function detectFades(audio: DecodedAudio): EventReport {
  factsOf(audio);
  const levels = frameLevelsDb(audio, ENVELOPE_FRAME_MS);
  const frameMs = ENVELOPE_FRAME_MS;
  const events: AudioEvent[] = [];
  let frame = 0;
  while (frame < levels.length) {
    if (levels[frame]! > DIGITAL_SILENCE_FLOOR_DBFS) {
      frame += 1;
      continue;
    }
    const silenceStart = frame;
    while (frame < levels.length && levels[frame]! <= DIGITAL_SILENCE_FLOOR_DBFS) frame += 1;
    if (silenceStart === 0) continue;

    // The plateau the fade left: the loudest frame in the half second before
    // the silence. The fade begins at the last frame still within half a
    // decibel of it; everything below is the ramp.
    const windowStart = Math.max(0, silenceStart - Math.round(500 / frameMs));
    let plateau = -Infinity;
    for (let index = windowStart; index < silenceStart; index += 1) {
      plateau = Math.max(plateau, levels[index]!);
    }
    if (plateau < SPEECH_FLOOR_DBFS) continue;
    let start = silenceStart - 1;
    while (start > windowStart && levels[start]! < plateau - 0.5) start -= 1;
    const durationMs = (silenceStart - start) * frameMs;
    if (durationMs < 2) continue;
    events.push({
      atMs: start * frameMs,
      durationMs,
    });
  }
  return {
    events,
    count: events.length,
    longestMs: events.reduce((longest, event) => Math.max(longest, event.durationMs), 0),
  };
}

function mergeWindows(events: readonly AudioEvent[]): AudioEvent[] {
  const windows: AudioEvent[] = [];
  for (const event of events) {
    const last = windows[windows.length - 1];
    if (last !== undefined && event.atMs <= last.atMs + last.durationMs) {
      windows[windows.length - 1] = {
        atMs: last.atMs,
        durationMs: event.atMs + event.durationMs - last.atMs,
      };
    } else {
      windows.push({ ...event });
    }
  }
  return windows;
}

/**
 * Frames the reference speaks (> -60 dBFS) and the delivered capture leaves
 * at digital silence. This is "silence sent as audio": the caller should have
 * heard a frame, and the delivered audio carries a hole instead. A frame the
 * reference is silent on is a natural pause and is not counted.
 */
export function silentFramesAgainstReference(
  reference: DecodedAudio,
  delivered: DecodedAudio,
  frameMs = ENVELOPE_FRAME_MS,
): SilentFrameReport {
  if (
    reference.facts.sampleRate !== delivered.facts.sampleRate ||
    reference.facts.channels !== delivered.facts.channels
  ) {
    throw new AudioAnalysisError(
      "format-mismatch",
      `silent frames need one format: reference ${reference.facts.sampleRate} Hz ` +
        `x${reference.facts.channels}ch, delivered ${delivered.facts.sampleRate} Hz ` +
        `x${delivered.facts.channels}ch`,
    );
  }
  const referenceLevels = frameLevelsDb(reference, frameMs);
  const deliveredLevels = frameLevelsDb(delivered, frameMs);
  const frames = Math.min(referenceLevels.length, deliveredLevels.length);
  const silent: AudioEvent[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    if (
      referenceLevels[frame]! > SILENCE_FLOOR_DBFS &&
      deliveredLevels[frame]! <= SILENCE_FLOOR_DBFS
    ) {
      silent.push({ atMs: frame * frameMs, durationMs: frameMs });
    }
  }
  return {
    frameMs,
    count: silent.length,
    windows: mergeWindows(silent),
  };
}

export type ContinuityReport = {
  readonly dropouts: EventReport;
  readonly clicks: EventReport;
  readonly defectCount: number;
  readonly longestDropoutMs: number;
};

/** A1's one measurement: dropouts, clicks and seams folded into one count. */
export function measureContinuity(audio: DecodedAudio): ContinuityReport {
  const dropouts = detectDropouts(audio);
  const clicks = detectClicks(audio);
  return {
    dropouts,
    clicks,
    defectCount: dropouts.count + clicks.count,
    longestDropoutMs: dropouts.longestMs,
  };
}
