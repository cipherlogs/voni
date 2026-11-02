/**
 * The preview mix places the caller's takes by the capture's recorded clock
 * anchor, not by a guessed origin. These tests drive the real CLI over a run
 * directory and read the WAV it writes back.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { decodeWav } from "@/lib/audio/format-facts";
import { encodeWavPcm16 } from "@/lib/voice/delivered-capture";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "demo-preview-mix.mjs");
const CAPTURE_RATE = 48_000;
const TAKE_RATE = 24_000;
const CAPTURE_MS = 1_000;
const CAPTURE_STARTED_MS = 200;
const TAKE_AT_MS = 500;
const TAKE_OFFSET_MS = TAKE_AT_MS - CAPTURE_STARTED_MS;
const AGENT_END_MS = 150;

function tone(sampleRate: number, ms: number, hz: number, amplitude = 0.2): Float32Array {
  const samples = new Float32Array(Math.round((sampleRate * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return samples;
}

/** One agent tone at the capture's start, then silence until teardown. */
function captureSamples(): Float32Array {
  const all = new Float32Array(Math.round((CAPTURE_RATE * CAPTURE_MS) / 1000));
  const agent = tone(CAPTURE_RATE, AGENT_END_MS, 440);
  all.set(agent, 0);
  return all;
}

type Fixture = {
  readonly root: string;
  readonly runDir: string;
  readonly corpusDir: string;
  readonly out: string;
};

function fixture(opts: { captureStarted?: number | null } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "preview-mix-"));
  const runDir = join(root, "run");
  const callDir = join(runDir, "calls", "call-1");
  const scenarioDir = join(root, "corpus", "placement");
  mkdirSync(callDir, { recursive: true });
  mkdirSync(join(scenarioDir, "takes"), { recursive: true });

  writeFileSync(
    join(callDir, "delivered.wav"),
    encodeWavPcm16(captureSamples(), CAPTURE_RATE),
  );
  writeFileSync(
    join(scenarioDir, "takes", "hello.wav"),
    encodeWavPcm16(tone(TAKE_RATE, 100, 880), TAKE_RATE),
  );
  writeFileSync(
    join(scenarioDir, "scenario.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: "placement",
        takes: [{ id: "hello", audio: "takes/hello.wav", text: "Hi." }],
        script: [{ take: "hello", trigger: { type: "call-open" } }],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(callDir, "call.json"),
    `${JSON.stringify(
      {
        callId: "call-1",
        scenario: "placement",
        timeline: {
          events: [
            { atMs: 100, type: "call-open" },
            // The agent tone ends 150 ms after the capture starts, so the
            // event and the audio agree on where the previous turn ended.
            { atMs: 350, type: "agent-speech-end" },
            { atMs: 350, type: "agent-turn-end" },
          ],
          spoken: [{ step: 0, take: "hello", atMs: TAKE_AT_MS }],
        },
        files: { deliveredWav: "delivered.wav", marks: "call-marks.json" },
      },
      null,
      2,
    )}\n`,
  );
  const marks =
    opts.captureStarted === null
      ? []
      : [
          {
            name: "capture_started",
            at: new Date("2026-11-03T10:00:00.000Z").toISOString(),
            epochMs: Date.parse("2026-11-03T10:00:00.000Z"),
            tMs: 0,
            detail: { atMs: opts.captureStarted ?? CAPTURE_STARTED_MS },
          },
        ];
  writeFileSync(
    join(callDir, "call-marks.json"),
    `${JSON.stringify({ schemaVersion: 1, callId: "call-1", marks }, null, 2)}\n`,
  );
  return { root, runDir, corpusDir: join(root, "corpus"), out: join(root, "mix.wav") };
}

/**
 * A real `.demo-runs/browser-*` directory: the Playwright report and run
 * records at the root, while the capture and marks live in the invocation's
 * `capturesDir` and are found by `callId`, as the harness writes them.
 */
function browserFixture(opts: {
  captureStarted?: number | null;
  writeCapture?: boolean;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "preview-mix-browser-"));
  const runDir = join(root, ".demo-runs", "browser-test");
  const capturesDir = join(root, ".captures");
  const scenarioDir = join(root, "corpus", "placement");
  const callId = "call-1";
  mkdirSync(runDir, { recursive: true });
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(scenarioDir, "takes"), { recursive: true });

  if (opts.writeCapture !== false) {
    writeFileSync(
      join(capturesDir, `delivered-${callId}-20261103-100000.wav`),
      encodeWavPcm16(captureSamples(), CAPTURE_RATE),
    );
  }
  writeFileSync(
    join(scenarioDir, "takes", "hello.wav"),
    encodeWavPcm16(tone(TAKE_RATE, 100, 880), TAKE_RATE),
  );
  writeFileSync(
    join(scenarioDir, "scenario.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: "placement",
        takes: [{ id: "hello", audio: "takes/hello.wav", text: "Hi." }],
        script: [{ take: "hello", trigger: { type: "call-open" } }],
      },
      null,
      2,
    )}\n`,
  );

  const marks =
    opts.captureStarted === null
      ? []
      : [
          {
            name: "capture_started",
            at: new Date("2026-11-03T10:00:00.000Z").toISOString(),
            epochMs: Date.parse("2026-11-03T10:00:00.000Z"),
            tMs: 0,
            detail: { atMs: opts.captureStarted ?? CAPTURE_STARTED_MS },
          },
        ];
  writeFileSync(
    join(capturesDir, `call-marks-${callId}.json`),
    `${JSON.stringify({ schemaVersion: 1, callId, marks }, null, 2)}\n`,
  );
  writeFileSync(
    join(runDir, "browser-invocation.json"),
    `${JSON.stringify({ schemaVersion: 1, scenario: "placement", capturesDir }, null, 2)}\n`,
  );
  writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify({ schemaVersion: 1, runId: "browser-test", scenario: "placement" }, null, 2)}\n`,
  );
  writeFileSync(
    join(runDir, "browser-call.json"),
    `${JSON.stringify(
      {
        callId,
        timeline: {
          events: [
            { atMs: 100, type: "call-open" },
            { atMs: 350, type: "agent-speech-end" },
            { atMs: 350, type: "agent-turn-end" },
          ],
          spoken: [{ step: 0, take: "hello", atMs: TAKE_AT_MS }],
        },
        marksPath: null,
        capturePath: null,
      },
      null,
      2,
    )}\n`,
  );
  return { root, runDir, corpusDir: join(root, "corpus"), out: join(root, "mix.wav") };
}

function runMix(data: Fixture) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      data.runDir,
      "--corpus",
      data.corpusDir,
      "--out",
      data.out,
    ],
    { encoding: "utf8" },
  );
}

test("a take is placed at atMs - capture_started, never inferred", () => {
  const data = fixture();
  try {
    const result = runMix(data);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /capture_started: 200\.0 ms/);
    assert.match(
      result.stdout,
      /150\.0 ms after the agent turn ended/,
      "the take starts after the previous agent turn's audio",
    );
    const wav = decodeWav(new Uint8Array(readFileSync(data.out)));
    assert.equal(wav.facts.sampleRate, CAPTURE_RATE);
    const expectedStart = Math.round((TAKE_OFFSET_MS * CAPTURE_RATE) / 1000);
    const agentEnd = Math.round((AGENT_END_MS * CAPTURE_RATE) / 1000);
    const firstCaller = wav.samples.findIndex(
      (sample, index) => index >= agentEnd && Math.abs(sample) > 1e-4,
    );
    // The tone's own first sample is zero; the placement is the frame it starts
    // on, so the first non-zero frame may be one sample after the offset.
    assert.ok(
      Math.abs(firstCaller - expectedStart) <= 1,
      `the first caller sample is ${firstCaller}, want ${expectedStart}`,
    );
    assert.equal(
      wav.samples.slice(agentEnd, expectedStart).some((sample) => Math.abs(sample) > 1e-4),
      false,
      "no caller audio before its placed start",
    );
    const peak = Math.max(...wav.samples.map(Math.abs)) / 32767;
    assert.ok(peak <= 0.99, `the mix is peak-safe: ${peak}`);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("a missing capture_started is a named refusal, not a guess", () => {
  const data = fixture({ captureStarted: null });
  try {
    const result = runMix(data);
    assert.notEqual(result.status, 0, "the mix is refused");
    assert.match(result.stderr, /missing-capture-start/);
    assert.match(result.stderr, /capture_started/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("a take placed before the capture's origin is refused by name", () => {
  const data = fixture({ captureStarted: TAKE_AT_MS + 100 });
  try {
    const result = runMix(data);
    assert.notEqual(result.status, 0, "the mix is refused");
    assert.match(result.stderr, /take-before-capture-start/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("a real browser-* run is read from browser-call.json and its captures dir", () => {
  const data = browserFixture();
  try {
    const result = runMix(data);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /capture_started: 200\.0 ms/);
    assert.match(
      result.stdout,
      /delivered-call-1-/,
      "the capture was found by callId in the invocation's capturesDir",
    );
    const wav = decodeWav(new Uint8Array(readFileSync(data.out)));
    const expectedStart = Math.round((TAKE_OFFSET_MS * CAPTURE_RATE) / 1000);
    const agentEnd = Math.round((AGENT_END_MS * CAPTURE_RATE) / 1000);
    const firstCaller = wav.samples.findIndex(
      (sample, index) => index >= agentEnd && Math.abs(sample) > 1e-4,
    );
    assert.ok(
      Math.abs(firstCaller - expectedStart) <= 1,
      `the first caller sample is ${firstCaller}, want ${expectedStart}`,
    );
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("a real browser-* run without capture_started refuses by name", () => {
  const data = browserFixture({ captureStarted: null });
  try {
    const result = runMix(data);
    assert.notEqual(result.status, 0, "the mix is refused");
    assert.match(result.stderr, /missing-capture-start/);
    assert.match(result.stderr, /capture_started/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("a real browser-* run without its capture refuses by name", () => {
  const data = browserFixture({ writeCapture: false });
  try {
    const result = runMix(data);
    assert.notEqual(result.status, 0, "the mix is refused");
    assert.match(result.stderr, /missing-capture/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
