/**
 * Breakups: inserted silences in delivered audio.
 *
 * A breakup is a hole, not a pause. Both are quiet stretches between two
 * pieces of speech, so duration alone cannot tell them apart — a natural
 * pause can be longer than a starvation hole. What differs is the edge: a
 * phrase decays into a natural pause and rises out of the next one, while an
 * inserted silence begins and ends at speech level because something upstream
 * cut the signal and resumed it.
 *
 * The analyser therefore reports a silence only when all three hold:
 *
 * 1. its frames are at or below the digital-silence floor,
 * 2. it is longer than the shortest hole worth naming, and
 * 3. speech is present on both sides and both edges are abrupt.
 *
 * Paired with its reference capture, this is the W0 breakup leg: the same
 * analyser runs over all three files, and a hole the delivered capture has
 * that the reference does not is the client's. A deliberate inter-sentence
 * silence already present in the source is indistinguishable from an inserted
 * one in a single file, which is why the comparison pairs the captures rather
 * than trusting one.
 *
 * The core is pure and reads only the decoded samples, so a saved file can be
 * re-analysed without a browser, network or database.
 */
import type { DecodedAudio } from "./format-facts";

/** Full-scale magnitude of a signed 16-bit sample. */
const FULL_SCALE = 32_768;

/** How far around a silence the surrounding speech level is sampled. */
const EDGE_CONTEXT_MS = 150;

/**
 * How quiet the frame touching a silence may be, relative to the surrounding
 * speech, and still count as an abrupt edge. A cut leaves the last frame at
 * speech level (0 dB below); a decay into a pause leaves it far below.
 */
const EDGE_DROP_DB = 12;

export type BreakupOptions = {
  /** Envelope frame length in milliseconds. Default 10. */
  frameMs?: number;
  /** Level at or below which a frame is digital silence, in dBFS. Default -60. */
  silenceFloorDb?: number;
  /** Shortest reported hole in milliseconds. Default 20. */
  minBreakupMs?: number;
};

export type Breakup = {
  /** Offset of the hole from the start of the file, in seconds. */
  startSeconds: number;
  /** Length of the hole, in seconds. */
  durationSeconds: number;
};

export type BreakupReport = {
  /** Every inserted silence, in order of occurrence. */
  breakups: Breakup[];
  /** How many inserted silences were found. */
  count: number;
  /** Sum of every inserted silence, in seconds. */
  totalSeconds: number;
  /** The longest inserted silence in seconds, or 0 when there is none. */
  longestSeconds: number;
};

const DEFAULTS: Required<BreakupOptions> = {
  frameMs: 10,
  silenceFloorDb: -60,
  minBreakupMs: 20,
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Mean-square level of each non-overlapping frame, in dBFS. A frame shorter
 * than the window (the tail of a file) is measured over what it contains.
 */
function frameLevelsDb(
  audio: DecodedAudio,
  frameSamples: number,
): number[] {
  const { samples, facts } = audio;
  const { channels, frameCount } = facts;
  const frames = Math.ceil(frameCount / frameSamples);
  const levels = new Array<number>(frames);

  for (let frame = 0; frame < frames; frame++) {
    const first = frame * frameSamples;
    const last = Math.min(first + frameSamples, frameCount);
    let sumSquares = 0;
    for (let index = first; index < last; index++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = samples[index * channels + channel];
        sumSquares += sample * sample;
      }
    }
    const count = (last - first) * channels;
    levels[frame] =
      count === 0 ? -Infinity : 10 * Math.log10(sumSquares / count / (FULL_SCALE * FULL_SCALE));
  }

  return levels;
}

/** The loudest frame in [from, to), or -Infinity when the range is empty. */
function loudest(levels: number[], from: number, to: number): number {
  let peak = -Infinity;
  for (let index = from; index < to; index++) {
    peak = Math.max(peak, levels[index]);
  }
  return peak;
}

/**
 * Detect inserted silences in a decoded file.
 *
 * A silence is reported when the frames inside it are at or below
 * `silenceFloorDb`, it lasts at least `minBreakupMs`, speech frames exist on
 * both sides, and the frames immediately touching it are within
 * `EDGE_DROP_DB` of the loudest speech around them. Leading and trailing
 * silence is not a breakup: it has speech on one side only.
 */
export function detectBreakups(
  audio: DecodedAudio,
  options: BreakupOptions = {},
): BreakupReport {
  const frameMs = options.frameMs ?? DEFAULTS.frameMs;
  const silenceFloorDb = options.silenceFloorDb ?? DEFAULTS.silenceFloorDb;
  const minBreakupMs = options.minBreakupMs ?? DEFAULTS.minBreakupMs;

  const frameSamples = Math.max(1, Math.round((audio.facts.sampleRate * frameMs) / 1000));
  const frameSeconds = frameSamples / audio.facts.sampleRate;
  const contextFrames = Math.max(1, Math.round(EDGE_CONTEXT_MS / frameMs));
  const minFrames = Math.max(1, Math.ceil(minBreakupMs / frameMs));
  const levels = frameLevelsDb(audio, frameSamples);

  const breakups: Breakup[] = [];
  let frame = 0;
  while (frame < levels.length) {
    if (levels[frame] > silenceFloorDb) {
      frame++;
      continue;
    }

    const start = frame;
    while (frame < levels.length && levels[frame] <= silenceFloorDb) frame++;
    const end = frame;

    // A file that opens or closes in silence is lead-in or lead-out, not a
    // hole: a hole has speech on both sides.
    if (start === 0 || end === levels.length) continue;
    if (end - start < minFrames) continue;

    const before = loudest(levels, Math.max(0, start - contextFrames), start);
    const after = loudest(levels, end, Math.min(levels.length, end + contextFrames));

    const entersAbruptly = levels[start - 1] >= before - EDGE_DROP_DB;
    const leavesAbruptly = levels[end] >= after - EDGE_DROP_DB;
    if (!entersAbruptly || !leavesAbruptly) continue;

    breakups.push({
      startSeconds: round3(start * frameSeconds),
      durationSeconds: round3((end - start) * frameSeconds),
    });
  }

  const totalSeconds = round3(
    breakups.reduce((sum, breakup) => sum + breakup.durationSeconds, 0),
  );
  const longestSeconds = round3(
    breakups.reduce((longest, breakup) => Math.max(longest, breakup.durationSeconds), 0),
  );

  return { breakups, count: breakups.length, totalSeconds, longestSeconds };
}
