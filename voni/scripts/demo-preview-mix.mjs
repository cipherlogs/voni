#!/usr/bin/env node
/**
 * Build a two-sided preview mix for one browser run: the delivered agent
 * capture plus the caller's committed takes, placed by the capture's real
 * clock anchor.
 *
 * A preview mix must never guess where the capture began. The browser call
 * writes one `capture_started` mark when the playout worklet writes its first
 * sample, in the same page clock as `timeline.spoken[].atMs`. This script reads
 * that mark and places every take at `atMs - capture_started`; if the anchor is
 * absent it refuses by name instead of falling back to the page origin, call
 * open or a correlation heuristic.
 *
 * Usage:
 *   node scripts/demo-preview-mix.mjs <run-dir> [--out <file>]
 *   node scripts/demo-preview-mix.mjs <run-dir> --call <call-id> [--corpus <dir>]
 *
 * `<run-dir>` is a `.demo-runs/<run-id>` run directory or one call directory.
 * The output defaults to `<call-dir>/preview-mix.wav`; the caller takes are read
 * from the committed scenario corpus unless `--corpus` names another root.
 *
 * The mix normalises the agent capture and each caller take to about -20 dBFS
 * RMS over their non-silent samples, then scales the whole mix only if its peak
 * would exceed full scale. It is a listening preview, not evidence.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VONI_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_CORPUS_DIR = resolve(
  VONI_ROOT,
  "src/lib/demo/verification/scenarios/corpus",
);
/** About -20 dBFS for each side, so neither side buries the other. */
const TARGET_RMS = 10 ** (-20 / 20);
/** The preview is a listening file: never leave it touching full scale. */
const PEAK_CEILING = 0.98;
/** Below this a sample is room tone, not signal, for the level measurement. */
const SILENCE = 1e-4;

export class PreviewMixError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PreviewMixError";
    this.code = code;
  }
}

function readJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PreviewMixError(
      code,
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ascii(bytes, at, length) {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[at + i] ?? 0);
  return text;
}

function fourcc(bytes, at) {
  return ascii(bytes, at, 4);
}

/** Parse a RIFF/WAVE 16-bit PCM file into mono float samples. */
function decodeWav(bytes, path) {
  if (bytes.length < 12 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WAVE") {
    throw new PreviewMixError("not-wav", `${path} is not a RIFF/WAVE file`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffSize = view.getUint32(4, true);
  if (riffSize + 8 > bytes.length) {
    throw new PreviewMixError("truncated", `${path} is shorter than its RIFF header claims`);
  }
  let format = null;
  let dataAt = -1;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = fourcc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) {
      throw new PreviewMixError("truncated", `${path}: "${id}" chunk is shorter than declared`);
    }
    if (id === "fmt ") {
      if (size < 16) throw new PreviewMixError("invalid-format", `${path}: "fmt " is ${size} bytes`);
      const encoding = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (encoding !== 1) {
        throw new PreviewMixError(
          "unsupported-format",
          `${path}: encoding ${encoding} is not PCM; only 16-bit PCM is supported`,
        );
      }
      if (bits !== 16) {
        throw new PreviewMixError(
          "unsupported-format",
          `${path}: ${bits}-bit samples; only 16-bit PCM is supported`,
        );
      }
      if (channels < 1) throw new PreviewMixError("invalid-format", `${path}: no channels`);
      format = { channels, sampleRate };
    } else if (id === "data") {
      dataAt = body;
      dataBytes = size;
    }
    offset = body + size + (size % 2);
  }
  if (format === null) throw new PreviewMixError("invalid-format", `${path}: no "fmt " chunk`);
  if (dataAt < 0) throw new PreviewMixError("invalid-format", `${path}: no "data" chunk`);
  const frames = Math.floor(dataBytes / (format.channels * 2));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      sum += view.getInt16(dataAt + (i * format.channels + channel) * 2, true);
    }
    samples[i] = sum / format.channels / 32768;
  }
  return { sampleRate: format.sampleRate, channels: format.channels, samples };
}

/** One standard WAV: RIFF/WAVE, 16-bit PCM, mono. */
function encodeWavPcm16(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (at, text) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const y = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(y * 32767), true);
  }
  return bytes;
}

/** Linear resampling is enough for a listening preview, and keeps the offset. */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i += 1) {
    const at = i * step;
    const low = Math.floor(at);
    const high = Math.min(samples.length - 1, low + 1);
    const fraction = at - low;
    out[i] = samples[low] * (1 - fraction) + samples[high] * fraction;
  }
  return out;
}

/** RMS over the samples that carry signal; digital silence is not level. */
function signalRms(samples) {
  let sum = 0;
  let count = 0;
  for (const sample of samples) {
    if (Math.abs(sample) >= SILENCE) {
      sum += sample * sample;
      count += 1;
    }
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/** Gain that puts a source at the preview's equal level, or a named refusal. */
function levelGain(samples, label) {
  const rms = signalRms(samples);
  if (rms === 0) {
    throw new PreviewMixError("silent-audio", `${label} has no non-silent samples to level`);
  }
  return TARGET_RMS / rms;
}

function resolveCallDirectory(runDir, callId) {
  if (existsSync(join(runDir, "call.json"))) return runDir;
  const callsDir = join(runDir, "calls");
  if (!existsSync(callsDir)) {
    throw new PreviewMixError(
      "missing-call",
      `${runDir} holds neither call.json nor a calls/ directory`,
    );
  }
  const candidates = readdirSync(callsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(callsDir, entry.name))
    .filter((dir) => existsSync(join(dir, "call.json")));
  if (candidates.length === 0) {
    throw new PreviewMixError("missing-call", `${callsDir} holds no call.json`);
  }
  if (callId !== null) {
    const match = candidates.find((dir) => {
      if (basename(dir) === callId) return true;
      const record = readJson(join(dir, "call.json"), "invalid-call");
      return record.callId === callId;
    });
    if (match === undefined) {
      throw new PreviewMixError(
        "missing-call",
        `${runDir} holds no call "${callId}"; available: ${candidates
          .map((dir) => basename(dir))
          .join(", ")}`,
      );
    }
    return match;
  }
  if (candidates.length > 1) {
    throw new PreviewMixError(
      "ambiguous-call",
      `${runDir} holds ${candidates.length} calls; pass --call <call-id> (${candidates
        .map((dir) => basename(dir))
        .join(", ")})`,
    );
  }
  return candidates[0];
}

function resolveArtifact(callDir, path, fallback) {
  if (typeof path === "string" && path.length > 0) {
    return resolve(callDir, path);
  }
  return join(callDir, fallback);
}

function scenarioTakeAudio(corpusDir, scenario, takeId) {
  const scenarioDir = resolve(corpusDir, scenario);
  const root = resolve(corpusDir);
  if (!scenarioDir.startsWith(root + sep)) {
    throw new PreviewMixError("invalid-scenario", `${scenario} escapes the corpus root`);
  }
  const scenarioPath = join(scenarioDir, "scenario.json");
  if (!existsSync(scenarioPath)) {
    throw new PreviewMixError(
      "missing-scenario",
      `${scenarioPath} does not exist; pass --corpus <dir> if this run used another corpus`,
    );
  }
  const document = readJson(scenarioPath, "invalid-scenario");
  const take = (document.takes ?? []).find((entry) => entry.id === takeId);
  if (take === undefined || typeof take.audio !== "string") {
    throw new PreviewMixError(
      "missing-take",
      `scenario "${scenario}" has no take "${takeId}" with an audio file`,
    );
  }
  const audio = resolve(scenarioDir, take.audio);
  if (!audio.startsWith(scenarioDir + sep)) {
    throw new PreviewMixError("invalid-take", `take "${takeId}" escapes ${scenarioDir}`);
  }
  if (!existsSync(audio)) {
    throw new PreviewMixError("missing-take", `${audio} does not exist`);
  }
  return audio;
}

function parseArgs(argv) {
  let runDir = null;
  let out = null;
  let call = null;
  let corpus = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--out" || token === "--call" || token === "--corpus") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new PreviewMixError("missing-value", `${token} needs a value`);
      }
      if (token === "--out") out = value;
      else if (token === "--call") call = value;
      else corpus = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new PreviewMixError(
        "unknown-flag",
        `unknown flag "${token}"; usage: demo-preview-mix <run-dir> [--out <file>] [--call <id>] [--corpus <dir>]`,
      );
    }
    if (runDir !== null) {
      throw new PreviewMixError("unknown-argument", `unexpected argument "${token}"`);
    }
    runDir = token;
  }
  if (runDir === null) {
    throw new PreviewMixError(
      "missing-run-dir",
      "usage: demo-preview-mix <run-dir> [--out <file>] [--call <id>] [--corpus <dir>]",
    );
  }
  return { runDir: resolve(runDir), out, call, corpus: corpus === null ? null : resolve(corpus) };
}

/**
 * The one placement rule: a take's zero is `atMs - capture_started` seconds
 * into the capture. No origin inference, no correlation.
 */
function placeTake(take, capture, captureStartedMs) {
  const atMs = numberOrNull(take.atMs);
  if (atMs === null) {
    throw new PreviewMixError(
      "missing-take-time",
      `timeline.spoken[] take "${take.take}" has no finite atMs`,
    );
  }
  const offsetMs = atMs - captureStartedMs;
  if (offsetMs < 0) {
    throw new PreviewMixError(
      "take-before-capture-start",
      `take "${take.take}" starts ${Math.abs(offsetMs).toFixed(1)} ms before the capture; ` +
        "capture_started is not a usable anchor",
    );
  }
  const offset = Math.round((offsetMs * capture.sampleRate) / 1000);
  if (offset >= capture.samples.length) {
    throw new PreviewMixError(
      "take-after-capture-end",
      `take "${take.take}" starts at ${offsetMs.toFixed(1)} ms, past the capture's ` +
        `${((capture.samples.length / capture.sampleRate) * 1000).toFixed(1)} ms`,
    );
  }
  return { offsetMs, offset };
}

function mixPreview({ record, capture, captureStartedMs, takes, corpusDir }) {
  const mixed = new Float32Array(capture.samples.length);
  const agentGain = levelGain(capture.samples, "the delivered capture");
  for (let i = 0; i < mixed.length; i += 1) mixed[i] = capture.samples[i] * agentGain;

  // The harness records the last played sample of every agent turn. A take
  // triggered by `agent-turn-end` therefore starts after that point; a negative
  // gap is an intentional barge-in or a wrong anchor and is reported, not
  // hidden.
  const agentEnds = (Array.isArray(record.timeline?.events) ? record.timeline.events : [])
    .filter((event) => event?.type === "agent-turn-end")
    .map((event) => numberOrNull(event.atMs))
    .filter((atMs) => atMs !== null);

  const placements = [];
  for (const take of takes) {
    const { offsetMs, offset } = placeTake(take, capture, captureStartedMs);
    const audioPath = scenarioTakeAudio(corpusDir, record.scenario, take.take);
    const audio = decodeWav(readFileSync(audioPath), audioPath);
    const samples = resample(audio.samples, audio.sampleRate, capture.sampleRate);
    const gain = levelGain(samples, `take "${take.take}"`);
    for (let i = 0; i < samples.length && offset + i < mixed.length; i += 1) {
      mixed[offset + i] += samples[i] * gain;
    }
    const previousEnd = agentEnds.filter((atMs) => atMs <= take.atMs).sort((a, b) => b - a)[0];
    const agentEndGapMs =
      previousEnd === undefined ? null : offsetMs - (previousEnd - captureStartedMs);
    placements.push({ ...take, offsetMs, samples: samples.length, path: audioPath, agentEndGapMs });
  }

  let peak = 0;
  for (const sample of mixed) peak = Math.max(peak, Math.abs(sample));
  const peakScale = peak > PEAK_CEILING ? PEAK_CEILING / peak : 1;
  if (peakScale < 1) {
    for (let i = 0; i < mixed.length; i += 1) mixed[i] *= peakScale;
  }
  return { samples: mixed, state: { agentGain, peak, peakScale, placements } };
}

function main(argv) {
  const args = parseArgs(argv);
  const callDir = resolveCallDirectory(args.runDir, args.call);
  const recordPath = join(callDir, "call.json");
  const record = readJson(recordPath, "invalid-call");

  const marksPath = resolveArtifact(callDir, record.files?.marks, "call-marks.json");
  const marks = readJson(marksPath, "missing-marks");
  const captureStartedMark = (Array.isArray(marks.marks) ? marks.marks : []).find(
    (mark) => mark?.name === "capture_started",
  );
  if (captureStartedMark === undefined) {
    throw new PreviewMixError(
      "missing-capture-start",
      `${marksPath} has no capture_started mark; refusing to guess the capture's origin`,
    );
  }
  const captureStartedMs = numberOrNull(captureStartedMark.detail?.atMs);
  if (captureStartedMs === null) {
    throw new PreviewMixError(
      "missing-capture-start",
      `the capture_started mark in ${marksPath} carries no finite atMs; refusing to guess ` +
        "the capture's origin",
    );
  }

  const timeline = record.timeline ?? {};
  const takes = Array.isArray(timeline.spoken) ? timeline.spoken : [];
  if (takes.length === 0) {
    throw new PreviewMixError(
      "missing-takes",
      `${recordPath} has no timeline.spoken[] caller takes to place`,
    );
  }

  const capturePath = resolveArtifact(callDir, record.files?.deliveredWav, "delivered.wav");
  if (!existsSync(capturePath)) {
    throw new PreviewMixError("missing-capture", `${capturePath} does not exist`);
  }
  const capture = decodeWav(readFileSync(capturePath), capturePath);
  const corpusDir = args.corpus ?? DEFAULT_CORPUS_DIR;
  if (typeof record.scenario !== "string" || record.scenario.length === 0) {
    throw new PreviewMixError("missing-scenario", `${recordPath} names no scenario`);
  }

  const { samples, state } = mixPreview({
    record,
    capture,
    captureStartedMs,
    takes,
    corpusDir,
  });

  const out = args.out === null ? join(callDir, "preview-mix.wav") : resolve(args.out);
  writeFileSync(out, encodeWavPcm16(samples, capture.sampleRate));

  const first = state.placements[0];
  console.log(`preview-mix: ${relative(process.cwd(), out) || out}`);
  console.log(
    `capture: ${relative(process.cwd(), capturePath) || capturePath} ` +
      `(${capture.sampleRate} Hz, ${(capture.samples.length / capture.sampleRate).toFixed(3)} s)`,
  );
  console.log(
    `capture_started: ${captureStartedMs.toFixed(1)} ms; first take starts ` +
      `${first.offsetMs.toFixed(1)} ms into the capture`,
  );
  for (const placement of state.placements) {
    const gap =
      placement.agentEndGapMs === null
        ? "no previous agent turn"
        : placement.agentEndGapMs >= 0
          ? `${placement.agentEndGapMs.toFixed(1)} ms after the agent turn ended`
          : `overlaps the agent turn by ${Math.abs(placement.agentEndGapMs).toFixed(1)} ms`;
    console.log(
      `  take ${placement.step} "${placement.take}" atMs ${placement.atMs.toFixed(1)} ` +
        `-> ${placement.offsetMs.toFixed(1)} ms (${placement.samples} samples; ${gap})`,
    );
  }
  console.log(
    `levels: agent gain ${state.agentGain.toFixed(3)}, peak ${state.peak.toFixed(3)}, ` +
      `peak scale ${state.peakScale.toFixed(3)}`,
  );
  return out;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`demo-preview-mix: ${message}`);
    process.exit(1);
  }
}

export {
  decodeWav,
  encodeWavPcm16,
  mixPreview,
  placeTake,
  resample,
  scenarioTakeAudio,
};
