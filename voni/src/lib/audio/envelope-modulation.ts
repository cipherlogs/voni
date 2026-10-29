/**
 * Envelope modulation: how fast and how deeply a recording's amplitude swings
 * in a periodic way — the measurement that turns a robotic, phased texture
 * into a number.
 *
 * The envelope is the signal's true amplitude (the magnitude of its analytic
 * signal), sampled at 2 kHz. The rate is the dominant frequency of that
 * envelope inside the modulation band, in hertz; the depth is the amplitude of
 * that sinusoid relative to the envelope's mean, which is a peak-to-trough
 * ratio: `0.5` means the envelope swings between half and one and a half times
 * its average. `depthDb` reports the same swing on a decibel scale.
 *
 * Pure — `DecodedAudio` in, a reading out — so a saved file is measured without
 * a browser, network or database.
 */
import type { DecodedAudio } from "./format-facts";

export type EnvelopeModulationOptions = {
  /** Lower edge of the modulation band, in hertz. Default 1. */
  minRateHz?: number;
  /** Upper edge of the modulation band, in hertz. Default 150. */
  maxRateHz?: number;
  /** Peak-to-trough depth at or above which the file counts as modulated. Default 0.05 (5%). */
  threshold?: number;
};

export type EnvelopeModulation = {
  /** Dominant modulation rate in hertz. `0` when the envelope is flat. */
  rateHz: number;
  /** Peak-to-trough swing as a ratio of the mean envelope, 0..1. */
  depth: number;
  /** The same swing in decibels: `20 log10((1 + depth) / (1 - depth))`. `Infinity` at a full trough. */
  depthDb: number;
  /** Whether `depth` clears the no-modulation threshold. */
  modulated: boolean;
};

const DEFAULT_MIN_RATE_HZ = 1;
const DEFAULT_MAX_RATE_HZ = 150;
const DEFAULT_THRESHOLD = 0.05;
/** Envelope samples per second; well above the band, so 150 Hz stays intact. */
const ENVELOPE_RATE_HZ = 2_000;
/** Fractions of a second discarded at each end, where the transform rings. */
const EDGE_SECONDS = 0.02;
/** Below this the residual is transform noise, not a modulation; no rate is reported. */
const DETECTION_FLOOR = 0.005;
/** Frequency grid for the periodogram, in hertz. */
const GRID_STEP_HZ = 0.5;

type RateFit = { rateHz: number; amplitude: number };

/** In-place iterative radix-2 Cooley–Tukey transform. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const reSwap = re[i];
      re[i] = re[j];
      re[j] = reSwap;
      const imSwap = im[i];
      im[i] = im[j];
      im[j] = imSwap;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const even = start + k;
        const odd = even + len / 2;
        const ar = re[odd] * cr - im[odd] * ci;
        const ai = re[odd] * ci + im[odd] * cr;
        re[odd] = re[even] - ar;
        im[odd] = im[even] - ai;
        re[even] += ar;
        im[even] += ai;
        const nextCr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextCr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Interleaved samples as one floating-point channel; amplitude scale is irrelevant. */
function mono(audio: DecodedAudio): Float64Array {
  const { channels } = audio.facts;
  const frames = Math.floor(audio.samples.length / channels);
  const out = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += audio.samples[frame * channels + channel];
    }
    out[frame] = sum / channels;
  }
  return out;
}

/**
 * The analytic signal's magnitude, decimated to the envelope rate. The Hilbert
 * transform gives a pure tone a perfectly flat envelope at any carrier
 * frequency, so a low hum is not mistaken for a fast modulation.
 */
function amplitudeEnvelope(signal: Float64Array, sampleRate: number): Float64Array {
  if (signal.length === 0) return new Float64Array(0);

  let length = 1;
  while (length < signal.length) length <<= 1;
  const re = new Float64Array(length);
  const im = new Float64Array(length);
  re.set(signal);
  fft(re, im, false);
  for (let k = 1; k < length / 2; k++) {
    re[k] *= 2;
    im[k] *= 2;
  }
  for (let k = length / 2 + 1; k < length; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  fft(re, im, true);

  const block = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE_HZ));
  const edge = Math.max(block, Math.round(EDGE_SECONDS * sampleRate));
  const envelope: number[] = [];
  for (let start = edge; start + block <= signal.length - edge; start += block) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += Math.hypot(re[i], im[i]);
    envelope.push(sum / block);
  }
  return Float64Array.from(envelope);
}

/** Hann window, mean removed; the periodogram of the envelope's deviations. */
type EnvelopeSpectrum = {
  deviations: Float64Array;
  window: Float64Array;
  windowSum: number;
  mean: number;
  envelopeRateHz: number;
};

function spectrum(envelope: Float64Array, envelopeRateHz: number): EnvelopeSpectrum {
  const count = envelope.length;
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= count;
  const deviations = new Float64Array(count);
  const window = new Float64Array(count);
  let windowSum = 0;
  for (let i = 0; i < count; i++) {
    deviations[i] = envelope[i] - mean;
    // A single-sample envelope has no taper to apply.
    window[i] = count > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) : 1;
    windowSum += window[i];
  }
  return { deviations, window, windowSum, mean, envelopeRateHz };
}

/** A sinusoid's amplitude at `rateHz` by least squares over the whole envelope. */
function amplitudeAt(spec: EnvelopeSpectrum, rateHz: number): number {
  const omega = (2 * Math.PI * rateHz) / spec.envelopeRateHz;
  let re = 0;
  let im = 0;
  for (let i = 0; i < spec.deviations.length; i++) {
    const weighted = spec.deviations[i] * spec.window[i];
    re += weighted * Math.cos(omega * i);
    im -= weighted * Math.sin(omega * i);
  }
  // Dividing by the window's coherent gain turns the transform into the
  // amplitude of the sinusoid, not the energy at a bin.
  return (2 * Math.hypot(re, im)) / spec.windowSum;
}

/** Find the strongest rate in the band, then refine it between grid points. */
function dominantRate(
  spec: EnvelopeSpectrum,
  minRateHz: number,
  maxRateHz: number,
): RateFit {
  let bestRateHz = minRateHz;
  let bestMagnitude = -1;
  for (let rateHz = minRateHz; rateHz <= maxRateHz + 1e-9; rateHz += GRID_STEP_HZ) {
    const magnitude = amplitudeAt(spec, rateHz);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      bestRateHz = rateHz;
    }
  }

  // Parabolic interpolation over log magnitudes places the peak between bins.
  const lower = Math.max(minRateHz, bestRateHz - GRID_STEP_HZ);
  const upper = Math.min(maxRateHz, bestRateHz + GRID_STEP_HZ);
  const lowerMagnitude = Math.log(amplitudeAt(spec, lower) + Number.EPSILON);
  const peakMagnitude = Math.log(bestMagnitude + Number.EPSILON);
  const upperMagnitude = Math.log(amplitudeAt(spec, upper) + Number.EPSILON);
  const curvature = lowerMagnitude - 2 * peakMagnitude + upperMagnitude;
  const offset =
    curvature === 0 ? 0 : (0.5 * (lowerMagnitude - upperMagnitude)) / curvature;
  const refined = Math.min(
    maxRateHz,
    Math.max(minRateHz, bestRateHz + Math.min(0.5, Math.max(-0.5, offset)) * GRID_STEP_HZ),
  );

  return { rateHz: refined, amplitude: amplitudeAt(spec, refined) };
}

function flat(): EnvelopeModulation {
  return { rateHz: 0, depth: 0, depthDb: 0, modulated: false };
}

function requireInRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}, got ${value}.`);
  }
}

/**
 * Measure a recording's periodic amplitude modulation. A flat envelope reports
 * a rate of zero and no modulation; an envelope that swings reports the rate
 * that dominates its band and the depth of that swing.
 */
export function measureEnvelopeModulation(
  audio: DecodedAudio,
  options: EnvelopeModulationOptions = {},
): EnvelopeModulation {
  const minRateHz = options.minRateHz ?? DEFAULT_MIN_RATE_HZ;
  const maxRateHz = options.maxRateHz ?? DEFAULT_MAX_RATE_HZ;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  requireInRange(minRateHz, 0.5, 999, "minRateHz");
  requireInRange(maxRateHz, minRateHz + GRID_STEP_HZ, 1_000, "maxRateHz");
  requireInRange(threshold, 0, 1, "threshold");

  const sampleRate = audio.facts.sampleRate;
  const block = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE_HZ));
  const envelopeRateHz = sampleRate / block;
  if (maxRateHz >= envelopeRateHz / 2) {
    throw new RangeError(
      `maxRateHz ${maxRateHz} must stay below the ${envelopeRateHz / 2} Hz envelope Nyquist limit.`,
    );
  }

  const envelope = amplitudeEnvelope(mono(audio), sampleRate);
  if (envelope.length < 4) return flat();

  const spec = spectrum(envelope, envelopeRateHz);
  if (!(spec.mean > 0)) return flat();

  const fit = dominantRate(spec, minRateHz, maxRateHz);
  const depth = Math.min(1, Math.max(0, fit.amplitude / spec.mean));
  if (depth < DETECTION_FLOOR) return flat();

  const depthDb = depth >= 1 ? Infinity : 20 * Math.log10((1 + depth) / (1 - depth));
  return { rateHz: fit.rateHz, depth, depthDb, modulated: depth >= threshold };
}
