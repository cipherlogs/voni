/**
 * Spectral balance for a saved recording: the octave-band balance and the
 * band-to-band delta a comparison needs to name the layer a tone defect came
 * from.
 *
 * The input is the `samples` a decoder already produced — nothing is decoded
 * twice, and nothing here touches the network or the browser. The core is
 * deterministic: the same samples always yield the same numbers, so two runs
 * on one saved file are directly comparable.
 */
import type { DecodedAudio } from "./format-facts";

/** ISO octave centres that carry a voice. */
export const SPEECH_OCTAVE_CENTRES = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const;

/** No measurable energy above this counts as a silent file, never as flat. */
const SILENCE_FLOOR_DBFS = -60;
/** A band this far below the loudest band has been lost, not just tilted. */
const MISSING_BELOW_DB = 20;
/** Max-min spread that still counts as balanced. */
const FLATNESS_DB = 6;
/** Adjacent bands averaged per spectrum; 0.25 s separates bands down to 63 Hz. */
const FRAME_SECONDS = 0.25;
/** Full-scale int16, the reference every level is quoted against. */
const FULL_SCALE = 32_768;
/** The band pair a tilt is quoted between. */
const DEFAULT_TILT = { fromCentreHz: 500, toCentreHz: 4000 } as const;

export type OctaveBandLevel = {
  /** Band centre, Hz. */
  centreHz: number;
  /** Band RMS level against full scale, dBFS. A silent band floors. */
  levelDb: number;
};

export type SpectralTilt = {
  fromCentreHz: number;
  toCentreHz: number;
  /** Upper band minus lower band, dB. Negative is a downward tilt. */
  deltaDb: number;
};

export type SpectralBalanceOptions = {
  /** Octave centres to measure, ascending. Bands above Nyquist are dropped. */
  centresHz?: readonly number[];
  /** A band this far below the loudest is reported as missing. */
  missingBelowDb?: number;
  /** Max-min spread that still counts as balanced. */
  flatnessDb?: number;
  /** Band pair the tilt is quoted between; both must be measured. */
  tilt?: { fromCentreHz: number; toCentreHz: number };
};

export type SpectralBalance = {
  /** Measured octave bands, ascending, each fully below Nyquist. */
  bands: OctaveBandLevel[];
  /** Loudest band minus quietest band, dB. */
  spreadDb: number;
  tilt: SpectralTilt;
  /** Bands at least `missingBelowDb` under the loudest band. */
  missingBands: OctaveBandLevel[];
  /** True only when nothing is missing and the spread is within `flatnessDb`. */
  balanced: boolean;
  /** True when the file carries no measurable energy above the floor. */
  silent: boolean;
  /** One sentence naming the first thing wrong, for the comparison table. */
  detail: string;
};

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size <<= 1;
  return size;
}

/**
 * In-place radix-2 FFT. Twiddles are tabulated once per call, so the same
 * input cannot drift between two runs on one file.
 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const size = re.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  const half = size >> 1;
  const twRe = new Float64Array(half);
  const twIm = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / size;
    twRe[k] = Math.cos(angle);
    twIm[k] = Math.sin(angle);
  }

  for (let length = 2; length <= size; length <<= 1) {
    const step = size / length;
    for (let start = 0; start < size; start += length) {
      for (let k = 0; k < length / 2; k++) {
        const twiddle = k * step;
        const vRe = re[start + k + length / 2] * twRe[twiddle] - im[start + k + length / 2] * twIm[twiddle];
        const vIm = re[start + k + length / 2] * twIm[twiddle] + im[start + k + length / 2] * twRe[twiddle];
        const uRe = re[start + k];
        const uIm = im[start + k];
        re[start + k] = uRe + vRe;
        im[start + k] = uIm + vIm;
        re[start + k + length / 2] = uRe - vRe;
        im[start + k + length / 2] = uIm - vIm;
      }
    }
  }
}

/** dBFS of a mean-square power, floored so a silent band still sorts. */
function dbfs(meanSquare: number): number {
  return meanSquare > 0 ? Math.max(-120, 10 * Math.log10(meanSquare)) : -120;
}

type Band = { centreHz: number; lowerBin: number; upperBin: number };

/**
 * Per-band mean square for one channel of interleaved samples. Frames are
 * Hann-windowed and averaged, so a tone anywhere in a band is measured once
 * rather than at whatever phase a single frame caught it.
 */
function bandPowers(
  samples: Int16Array,
  channels: number,
  channel: number,
  bands: readonly Band[],
  frameCount: number,
): number[] {
  const fftSize = nextPowerOfTwo(frameCount);
  const totalFrames = samples.length / channels;
  // Half-overlapping frames where the file allows it; a long file widens the
  // hop instead of analysing thousands of frames.
  const hop = Math.max(Math.floor(frameCount / 2), Math.ceil(totalFrames / 256));
  const frameStarts: number[] = [];
  for (let start = 0; start < totalFrames; start += hop) frameStarts.push(start);

  const window = new Float64Array(frameCount);
  let windowPower = 0;
  for (let i = 0; i < frameCount; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / frameCount));
    windowPower += window[i] * window[i];
  }
  if (windowPower === 0) windowPower = 1;

  const bandMeanSquares = bands.map(() => 0);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (const start of frameStarts) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < frameCount; i++) {
      const frame = start + i;
      const value = frame < totalFrames ? samples[frame * channels + channel] / FULL_SCALE : 0;
      re[i] = value * window[i];
    }
    fftInPlace(re, im);

    bands.forEach((band, index) => {
      let power = 0;
      for (let bin = band.lowerBin; bin <= band.upperBin; bin++) {
        const magnitude = re[bin] * re[bin] + im[bin] * im[bin];
        // One-sided spectrum: an interior bin carries its negative twin.
        const oneSided = bin === 0 || bin === fftSize / 2 ? magnitude : 2 * magnitude;
        power += oneSided / fftSize;
      }
      bandMeanSquares[index] += power / windowPower;
    });
  }

  return bandMeanSquares.map((power) => power / frameStarts.length);
}

function meanSquareOf(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] / FULL_SCALE;
    sum += value * value;
  }
  return sum / samples.length;
}

function bandIndex(bands: readonly OctaveBandLevel[], centreHz: number): number {
  const index = bands.findIndex((band) => band.centreHz === centreHz);
  if (index < 0) {
    const measured = bands.map((band) => band.centreHz).join(", ");
    throw new RangeError(`No octave band at ${centreHz} Hz; measured bands are ${measured}.`);
  }
  return index;
}

/**
 * Measure the octave-band balance of decoded audio. The bands a sample rate
 * cannot carry are dropped rather than folded, so a 16 kHz file never reports
 * an 8 kHz band it cannot contain.
 */
export function measureSpectralBalance(
  audio: DecodedAudio,
  options: SpectralBalanceOptions = {},
): SpectralBalance {
  const { sampleRate, channels } = audio.facts;
  if (audio.samples.length === 0 || audio.samples.length % channels !== 0) {
    throw new RangeError(
      `Decoded audio has ${audio.samples.length} samples across ${channels} channels; nothing to measure.`,
    );
  }

  const missingBelowDb = options.missingBelowDb ?? MISSING_BELOW_DB;
  const flatnessDb = options.flatnessDb ?? FLATNESS_DB;
  const tiltPair = options.tilt ?? DEFAULT_TILT;
  const nyquist = sampleRate / 2;
  const centres = (options.centresHz ?? SPEECH_OCTAVE_CENTRES).filter(
    (centreHz) => centreHz * Math.SQRT2 <= nyquist,
  );
  if (centres.length === 0) {
    throw new RangeError(`${sampleRate} Hz carries none of the octave bands requested.`);
  }

  const frameCount = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));
  const fftSize = nextPowerOfTwo(frameCount);
  const binHz = sampleRate / fftSize;
  const bands: Band[] = centres.map((centreHz) => ({
    centreHz,
    lowerBin: Math.max(0, Math.ceil((centreHz / Math.SQRT2) / binHz)),
    upperBin: Math.min(fftSize / 2, Math.floor(centreHz * Math.SQRT2 / binHz)),
  }));

  // Each channel is measured on its own and then averaged, so a phase
  // difference between channels cannot cancel a band out of the balance.
  const accumulated = bands.map(() => 0);
  for (let channel = 0; channel < channels; channel++) {
    const powers = bandPowers(audio.samples, channels, channel, bands, frameCount);
    powers.forEach((power, index) => {
      accumulated[index] += power / channels;
    });
  }

  const bandLevels: OctaveBandLevel[] = bands.map((band, index) => ({
    centreHz: band.centreHz,
    levelDb: Number(dbfs(accumulated[index]).toFixed(2)),
  }));

  const loudest = Math.max(...bandLevels.map((band) => band.levelDb));
  const quietest = Math.min(...bandLevels.map((band) => band.levelDb));
  const spreadDb = Number((loudest - quietest).toFixed(2));
  const missingBands = bandLevels.filter((band) => band.levelDb <= loudest - missingBelowDb);
  const fromIndex = bandIndex(bandLevels, tiltPair.fromCentreHz);
  const toIndex = bandIndex(bandLevels, tiltPair.toCentreHz);
  const tilt: SpectralTilt = {
    fromCentreHz: tiltPair.fromCentreHz,
    toCentreHz: tiltPair.toCentreHz,
    deltaDb: Number((bandLevels[toIndex].levelDb - bandLevels[fromIndex].levelDb).toFixed(2)),
  };

  const overallDb = dbfs(meanSquareOf(audio.samples));
  const silent = overallDb < SILENCE_FLOOR_DBFS;
  const balanced = !silent && missingBands.length === 0 && spreadDb <= flatnessDb;

  let detail: string;
  if (silent) {
    detail = `silent: overall ${overallDb.toFixed(1)} dBFS is below the ${SILENCE_FLOOR_DBFS} dBFS floor, so the balance is unmeasured`;
  } else if (missingBands.length > 0) {
    const lost = missingBands
      .map((band) => `${band.centreHz} Hz at ${band.levelDb.toFixed(1)} dBFS`)
      .join(", ");
    detail = `octave band lost: ${lost}, more than ${missingBelowDb} dB under the ${loudest.toFixed(1)} dBFS loudest band`;
  } else if (!balanced) {
    detail = `spectral tilt ${tilt.deltaDb.toFixed(1)} dB between ${tilt.fromCentreHz} Hz and ${tilt.toCentreHz} Hz; spread ${spreadDb.toFixed(1)} dB exceeds ${flatnessDb} dB`;
  } else {
    detail = `band balance within ${spreadDb.toFixed(1)} dB across ${bandLevels.length} octave bands, tilt ${tilt.deltaDb.toFixed(1)} dB between ${tilt.fromCentreHz} Hz and ${tilt.toCentreHz} Hz`;
  }

  return {
    bands: bandLevels,
    spreadDb,
    tilt,
    missingBands,
    balanced,
    silent,
    detail,
  };
}
