import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

import { DEMO_TEST_USE } from "./demo-fakes";
import {
  FAKE_SAMPLE_RATE,
  fakeCascadeServer,
  recordedCall,
  replyAudioSeconds,
  replyToneHz,
  uniqueAudioSeconds,
} from "./cascade-fake-server";
import { SCOREBOARD_BUDGETS } from "../../src/lib/demo/scoreboard-budgets";

/**
 * Seam 4 (tickets 149/150): a real Chromium runs the real browser client
 * (`CascadeSession`), the real mic path and the real playout worklet, and the
 * service half is the deterministic fake in `./cascade-fake-server`.
 *
 * 149 proved a delivered capture is written on every PR. 150 makes the seam
 * *say* what the caller experienced, so a client regression fails here before
 * a live call:
 *
 *  - the stamped source rate is what the playout played (the fixture is 16 kHz,
 *    not the client's 24 kHz default, and the captured pitch proves which one
 *    reached the speaker);
 *  - the cushion/drift correctors never amplitude-modulate the voice;
 *  - a barge-in flushes and cuts inside `realCutMs` from the frozen budget
 *    record, and the next reply is heard;
 *  - the connected chime fires once, on the first audible sample — never
 *    before audio arrives;
 *  - a replayed `seq` is dropped (the second reply stays its scripted length);
 *  - the goodbye drains before the client hangs up;
 *  - the WAV is the worklet's output, sample-continuous and dead-air-free.
 *
 * It is not a live vendor run: one `delivered` leg, no `reference` or
 * `platform` leg, kind `browser-delivery`. Its artifact is a browser-delivery
 * artifact, not a cutover artifact.
 */

test.use(DEMO_TEST_USE);

/** Where the harness puts its working artifacts; CI uploads this directory. */
const ARTIFACT_DIR = process.env.VONI_E2E_ARTIFACT_DIR ?? "";

/** Below this RMS a window is silence, not the 0.25-amplitude scripted tone. */
const SILENCE_RMS = 0.02;
/** Analysis window: long enough for a stable zero-crossing pitch at 440 Hz. */
const WINDOW_SECONDS = 0.02;
/** A window whose pitch is within this much of a reply's tone belongs to it. */
const PITCH_TOLERANCE = 0.08;
/** The cut budget: the frozen stop-over contract, never a literal. */
const REAL_CUT_MS = SCOREBOARD_BUDGETS.realCutMs.value;
/** No uncovered silence past this; also from the frozen budget record. */
const DEAD_AIR_MAX_MS = SCOREBOARD_BUDGETS.deadAirMaxMs.value;

type Wav = {
  audioFormat: number;
  channels: number;
  bitsPerSample: number;
  sampleRate: number;
  samples: Int16Array;
  seconds: number;
};

/** A standard RIFF/WAVE PCM16 mono file, or a named refusal. */
function parseWav(bytes: Buffer): Wav {
  expect(bytes.subarray(0, 4).toString("ascii"), "RIFF magic").toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("ascii"), "WAVE form").toBe("WAVE");
  expect(bytes.subarray(12, 16).toString("ascii"), "fmt chunk").toBe("fmt ");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  expect(bytes.byteLength, "data chunk length matches the file").toBe(44 + dataBytes);
  expect(bytes.subarray(36, 40).toString("ascii"), "data chunk").toBe("data");
  const samples = new Int16Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true);
  return {
    audioFormat,
    channels,
    bitsPerSample,
    sampleRate,
    samples,
    seconds: samples.length / sampleRate,
  };
}

type Window = {
  atSeconds: number;
  rms: number;
  /** Zero-crossing pitch estimate, or null in silence. */
  hz: number | null;
  /** Which scripted reply this window belongs to, or null. */
  reply: string | null;
};

/**
 * Cut the capture into 20 ms windows of audible level and zero-crossing pitch.
 * The two scripted replies are different tones (440 Hz then 730 Hz), so a
 * window's pitch says which reply the caller was hearing — even where the
 * barge-in fade runs into the next reply.
 */
function analyse(wav: Wav, tones: Record<string, number>): Window[] {
  const size = Math.max(2, Math.round(wav.sampleRate * WINDOW_SECONDS));
  const windows: Window[] = [];
  for (let start = 0; start + size <= wav.samples.length; start += size) {
    let sum = 0;
    let crossings = 0;
    for (let i = start; i < start + size; i++) {
      const sample = wav.samples[i]!;
      const value = sample / 32768;
      sum += value * value;
      if (i > start && (wav.samples[i - 1]! < 0) !== (sample < 0)) crossings += 1;
    }
    const rms = Math.sqrt(sum / size);
    const hz = rms >= SILENCE_RMS ? crossings / 2 / WINDOW_SECONDS : null;
    let reply: string | null = null;
    if (hz !== null) {
      for (const [name, tone] of Object.entries(tones)) {
        if (Math.abs(hz - tone) / tone <= PITCH_TOLERANCE) reply = name;
      }
    }
    windows.push({ atSeconds: start / wav.sampleRate, rms, hz, reply });
  }
  return windows;
}

function secondsOf(windows: Window[], reply: string): number {
  return windows.filter((window) => window.reply === reply).length * WINDOW_SECONDS;
}

function medianPitch(windows: Window[], reply: string): number {
  const pitches = windows
    .filter((window) => window.reply === reply && window.hz !== null)
    .map((window) => window.hz as number)
    .sort((a, b) => a - b);
  expect(pitches.length, `the ${reply} reply is audible`).toBeGreaterThan(0);
  return pitches[Math.floor(pitches.length / 2)]!;
}

/** The longest silent stretch between the first and last audible window. */
function longestDeadAirMs(windows: Window[]): number {
  const voiced = windows.map((window) => window.hz !== null);
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  let longest = 0;
  let run = 0;
  for (let i = first; i >= 0 && i <= last; i++) {
    if (voiced[i]) run = 0;
    else {
      run += 1;
      longest = Math.max(longest, run);
    }
  }
  return longest * WINDOW_SECONDS * 1000;
}

/** The largest step between adjacent samples: a seam or click, not a tone. */
function peakSampleStep(samples: Int16Array): number {
  let peak = 0;
  for (let i = 1; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]! - samples[i - 1]!));
  }
  return peak;
}

/** Level modulation of one reply: constant for a tone, pumping for a bug. */
function levelSpread(windows: Window[], reply: string): number {
  const levels = windows
    .filter((window) => window.reply === reply)
    .map((window) => window.rms)
    .slice(3, -3); // ignore the reply's own edge fades
  if (levels.length < 3) return 1;
  return Math.max(...levels) / Math.min(...levels);
}

test("a real cascade call proves the client's behaviours and writes a delivered capture", async ({
  page,
}, testInfo) => {
  const captures: { name: string; bytes: Buffer }[] = [];
  const vendorRequests: string[] = [];
  const pageErrors: string[] = [];
  const sounds: { url: string; at: number }[] = [];

  // Every app route is offline in this seam; the fake serves voice. Register
  // the catch-all first: Playwright runs the most recently added matching
  // handler, so the capture sink below must come after it.
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: { error: "offline in e2e" } }),
  );
  // The delivered-capture sink: the WAV the playout worklet emitted, saved by
  // the harness so the run's artifact outlives the throwaway candidate.
  await page.route("**/api/dev/delivered-capture**", async (route) => {
    const bytes = route.request().postDataBuffer();
    if (bytes) {
      const name = new URL(route.request().url()).searchParams.get("name") ?? "delivered.wav";
      captures.push({ name, bytes });
    }
    await route.fulfill({ json: { path: "captured-by-the-e2e-harness" } });
  });
  // Live guard (ticket 151's rule enforced from this side too): the browser E2E
  // must not reach a vendor host, and a frame that tries is named below.
  await page.route(
    /(api\.meta\.ai|agents\.assemblyai\.com|api\.assemblyai\.com|tts\.assemblyai\.com|cartesia\.ai)/,
    (route) => {
      vendorRequests.push(route.request().url());
      return route.abort();
    },
  );
  // The connected chime is a real HTMLAudio request (call-sounds.ts), so its
  // arrival time is the browser's, not a test double's.
  page.on("request", (request) => {
    if (/\/sounds\/[^/]+\/connected\.mp3$/.test(new URL(request.url()).pathname)) {
      sounds.push({ url: request.url(), at: Date.now() });
    }
  });

  const script = recordedCall();
  const fake = await fakeCascadeServer(page, script);
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/e2e/cascade?delivercapture=1");
  await expect(page.getByTestId("cascade-e2e-shell")).toBeVisible();

  // A click before hydration does nothing; click again, as a person would.
  const start = page.getByRole("button", { name: /^call voni$/i }).filter({ visible: true }).first();
  await expect(async () => {
    if (!fake.opened()) await start.click({ timeout: 1000 }).catch(() => undefined);
    await expect.poll(fake.opened, { timeout: 3000 }).toBe(true);
  }).toPass({ timeout: 20_000 });

  // Ticket 65's contract: identity only. A leaked prompt, tool list or
  // pipeline would be a client regression, and this seam fails on it.
  await expect.poll(() => fake.config() !== null).toBe(true);
  const config = fake.config() as Record<string, unknown>;
  expect(Object.keys(config).sort()).toEqual(
    ["agentId", "callToken", "protocolVersion", "type"].sort(),
  );
  expect(config.type).toBe("config");
  expect(config.agentId).toBe("agent_e2e");
  expect(config.protocolVersion).toBe(1);

  // The scripted service speaks, is barged in on, speaks again, replays two
  // frames and hangs up; the client drains the goodbye before it stops.
  await fake.play();
  await expect
    .poll(() => fake.audioFrames(), { message: "the real mic path sent audio" })
    .toBeGreaterThan(0);
  await expect
    .poll(() => captures.length, { message: "the delivered capture was written", timeout: 20_000 })
    .toBe(1);
  await expect.poll(() => fake.stopAt(), { timeout: 10_000 }).not.toBeNull();
  await expect(page.locator('[data-voice-state="ended"]')).toBeVisible();

  // ── The capture is the worklet's output ─────────────────────────────────
  const capture = captures[0]!;
  const wav = parseWav(capture.bytes);
  expect(wav.audioFormat, "PCM").toBe(1);
  expect(wav.channels, "mono").toBe(1);
  expect(wav.bitsPerSample, "16-bit").toBe(16);
  expect(wav.sampleRate, "the worklet's device rate").toBeGreaterThanOrEqual(FAKE_SAMPLE_RATE);

  // ── The negotiated format is the rate that was played ────────────────────
  // The fixture's source rate is deliberately NOT the client's 24 kHz default,
  // so a client that ignored the frame's stamp would pitch-shift and shorten
  // the reply. Both are asserted by the pitch and the reply lengths below.
  const sourceRates = new Set(
    script
      .filter((entry) => entry.frame.type === "audio")
      .map((entry) => entry.frame.sample_rate),
  );
  expect([...sourceRates], "every frame stamps the session's confirmed rate").toEqual([
    FAKE_SAMPLE_RATE,
  ]);

  const tones = { first: replyToneHz("first", script), second: replyToneHz("second", script) };
  const windows = analyse(wav, tones);

  for (const reply of ["first", "second"] as const) {
    const measured = medianPitch(windows, reply);
    expect(
      measured,
      `the ${reply} reply plays at its stamped rate: ${tones[reply]} Hz expected, ${measured.toFixed(1)} Hz heard`,
    ).toBeGreaterThan(tones[reply] * 0.97);
    expect(measured).toBeLessThan(tones[reply] * 1.03);
  }

  // ── Barge-in flushes and cuts inside the cut budget ──────────────────────
  const firstAudioAt = fake.firstAudioAt();
  const interruptedAt = fake.interruptedAt();
  expect(firstAudioAt, "the script spoke before it was interrupted").not.toBeNull();
  expect(interruptedAt, "the script barged in").not.toBeNull();
  const elapsedToCut = (interruptedAt! - firstAudioAt!) / 1000;
  const firstReplySeconds = secondsOf(windows, "first");
  expect(firstReplySeconds, "the interrupted reply was actually sounding").toBeGreaterThan(0.1);
  expect(
    firstReplySeconds * 1000,
    `the barge-in cut the reply within realCutMs (${REAL_CUT_MS}ms) of the caller's ${Math.round(elapsedToCut * 1000)}ms of speech`,
  ).toBeLessThan(elapsedToCut * 1000 + REAL_CUT_MS);

  // ── The next reply is heard, in order, and the replayed frames are not ───
  const secondReplySeconds = secondsOf(windows, "second");
  const scriptedSecond = replyAudioSeconds("second", script);
  expect(
    secondReplySeconds,
    "the reply after the flush is fully heard, and the replayed seq frames are dropped",
  ).toBeGreaterThan(scriptedSecond - 0.2);
  expect(secondReplySeconds).toBeLessThan(scriptedSecond + 0.2);
  expect(
    windows.findIndex((window) => window.reply === "second"),
    "the second reply follows the first",
  ).toBeGreaterThan(windows.findIndex((window) => window.reply === "first"));

  // ── Cushion and drift do not modulate the voice ─────────────────────────
  // The worklet's contract: the cushion is not a gain, and drift correction is
  // a rate adjustment bounded at ±1%. A constant tone therefore stays at a
  // constant level and pitch; pumping or a wider pitch swing fails here.
  for (const reply of ["first", "second"] as const) {
    expect(
      levelSpread(windows, reply),
      `the ${reply} reply is not amplitude-modulated by the cushion`,
    ).toBeLessThan(1.5);
  }

  // ── No dead air beyond the named bound, no seam in the samples ──────────
  expect(
    longestDeadAirMs(windows),
    `no uncovered silence past ${DEAD_AIR_MAX_MS}ms inside the call`,
  ).toBeLessThanOrEqual(DEAD_AIR_MAX_MS);
  // A 440/730 Hz tone at 16-bit steps by under ~1600 per sample; two overlapping
  // tones stay under ~3200. A dropped or repeated tap block, or a resampler
  // seam, jumps by thousands of counts.
  expect(peakSampleStep(wav.samples), "the capture has no block seam or click").toBeLessThan(4000);

  // ── The connected chime fires once, on the first audible sample ─────────
  expect(sounds.length, "the connected chime fired exactly once").toBe(1);
  expect(
    sounds[0]!.at,
    "the chime waits for the first audible sample, never the socket",
  ).toBeGreaterThanOrEqual(firstAudioAt!);
  expect(
    sounds[0]!.at - firstAudioAt!,
    "the chime is not delayed to the end of the reply",
  ).toBeLessThan(3000);

  // ── The goodbye drains before hang-up ───────────────────────────────────
  const endCallAt = fake.endCallAt();
  expect(endCallAt, "the service sent end_call").not.toBeNull();
  const drainMs = fake.stopAt()! - endCallAt!;
  expect(
    drainMs,
    "the goodbye played through before the client hung up",
  ).toBeGreaterThan(scriptedSecond * 1000 * 0.8);
  expect(drainMs, "and the line was not held after it").toBeLessThan(8000);
  expect(
    secondReplySeconds,
    "the capture contains the whole goodbye",
  ).toBeGreaterThan(scriptedSecond * 0.8);
  // The capture was written by the hang-up, so it can only be complete if the
  // drain finished first: one file, and the wire saw the goodbye.
  expect(uniqueAudioSeconds(script), "the script had unique audio to deliver").toBeGreaterThan(0);

  // ── The artifact is a browser-delivery artifact, not a cutover artifact ──
  const dir = ARTIFACT_DIR ? resolve(ARTIFACT_DIR) : testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  const wavPath = resolve(dir, "browser-delivered.wav");
  writeFileSync(wavPath, capture.bytes);
  const sidecar = {
    kind: "browser-delivery",
    schemaVersion: 1,
    pipeline: "cascade",
    gate: "ci.browser-e2e",
    recordedAt: new Date().toISOString(),
    command: "node scripts/e2e-run.mjs cascade",
    capture: {
      file: "browser-delivered.wav",
      name: capture.name,
      bytes: capture.bytes.byteLength,
      samples: wav.samples.length,
      sampleRate: wav.sampleRate,
      seconds: Number(wav.seconds.toFixed(3)),
      sha256: createHash("sha256").update(capture.bytes).digest("hex"),
    },
    /** What this run observed, in the units the assertions use. */
    observed: {
      sourceRate: FAKE_SAMPLE_RATE,
      tonesHz: tones,
      firstReplySeconds: Number(firstReplySeconds.toFixed(3)),
      bargeInToCutMs: Math.round(elapsedToCut * 1000),
      cutBudgetMs: REAL_CUT_MS,
      secondReplySeconds: Number(secondReplySeconds.toFixed(3)),
      scriptedSecondSeconds: scriptedSecond,
      deadAirWorstMs: Math.round(longestDeadAirMs(windows)),
      deadAirBudgetMs: DEAD_AIR_MAX_MS,
      peakSampleStep: peakSampleStep(wav.samples),
      connectedChimeMs: sounds[0]!.at - firstAudioAt!,
      goodbyeDrainMs: drainMs,
    },
    /** One leg only: this run never observed a reference or platform capture. */
    legs: ["delivered"],
    /**
     * Non-intrusiveness is pinned sample-for-sample by the unit seam
     * (`cascade-session.test.ts`: "enabling the cascade tap changes nothing the
     * worklet plays"); here the capture's continuity, pitch and length are the
     * end-to-end half of that claim.
     */
    nonIntrusiveProof: "cascade-session.test.ts#enabling-the-cascade-tap",
  };
  writeFileSync(resolve(dir, "browser-delivery.json"), `${JSON.stringify(sidecar, null, 2)}\n`);
  expect(sidecar.legs).toEqual(["delivered"]);
  expect(Object.keys(sidecar)).not.toContain("platform");
  expect(Object.keys(sidecar)).not.toContain("reference");

  // A live vendor run is exactly what this is not.
  expect(vendorRequests, "no vendor host was contacted").toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(fake.frames.map((frame) => frame.type)).toContain("stop");
});

test("an error is visible, and no chime fires without an audible sample", async ({ page }) => {
  const captures: { name: string; bytes: Buffer }[] = [];
  const sounds: string[] = [];

  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: { error: "offline in e2e" } }),
  );
  await page.route("**/api/dev/delivered-capture**", async (route) => {
    const bytes = route.request().postDataBuffer();
    if (bytes) captures.push({ name: "delivered.wav", bytes });
    await route.fulfill({ json: { path: "captured-by-the-e2e-harness" } });
  });
  page.on("request", (request) => {
    if (/\/sounds\/[^/]+\/connected\.mp3$/.test(new URL(request.url()).pathname)) {
      sounds.push(request.url());
    }
  });

  const fake = await fakeCascadeServer(page, []);
  await page.goto("/e2e/cascade");

  const start = page.getByRole("button", { name: /^call voni$/i }).filter({ visible: true }).first();
  await expect(async () => {
    if (!fake.opened()) await start.click({ timeout: 1000 }).catch(() => undefined);
    await expect.poll(fake.opened, { timeout: 3000 }).toBe(true);
  }).toPass({ timeout: 20_000 });
  await expect.poll(() => fake.config() !== null).toBe(true);

  // The service fails mid-call before any audio: the caller must see why, and
  // the connected chime (first audible sample) must never have fired.
  await fake.say({ type: "caption", role: "agent", text: "One moment.", final: true });
  await fake.say({ type: "error", message: "The voice service dropped the call." });

  const alert = page.getByTestId("cascade-e2e-shell").getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("The voice service dropped the call.");
  expect(sounds, "no audio ever sounded, so the chime stayed silent").toEqual([]);
  expect(captures, "a call with no audible sample writes no capture").toEqual([]);
});
