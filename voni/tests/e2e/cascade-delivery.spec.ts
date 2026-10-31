import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { DEMO_TEST_USE } from "./demo-fakes";
import {
  FAKE_SAMPLE_RATE,
  fakeCascadeServer,
  loadScriptedService,
  recordedCall,
  replyAudioSeconds,
  replyToneHz,
  uniqueAudioSeconds,
} from "./cascade-fake-server";
import { SCOREBOARD_BUDGETS } from "../../src/lib/demo/scoreboard-budgets";
import { DEMO_UNAVAILABLE_MESSAGES } from "../../src/lib/voice/cascade-failure-view";

/**
 * Seam 2 (demo-cascade ticket 16): the landing demo, against a fake pipeline.
 *
 * A real Chromium opens the PUBLIC landing page (`/`), presses Start call, and
 * runs the real demo client: the one mint (`/api/demo/token`, answered here
 * with the cascade contract), the real `CascadeSession`, the real mic path and
 * the real playout worklet. The service half is the deterministic fake in
 * `./cascade-fake-server`, which replays the committed script — captions,
 * numbered PCM at a stamped rate, a barge-in, the pipeline's server-side
 * `show_test_address` line, a replayed frame, `end_call` and a clean close.
 *
 * What this seam proves, end to end:
 *
 *  - the demo's Start call opens the CASCADE socket (never a managed one), with
 *    identity only: agentId `demo:<voice>`, a call token, the protocol version;
 *  - the greeting caption and its audio reach the caller;
 *  - a barge-in cuts the greeting inside the frozen budget and the next reply
 *    is heard in full;
 *  - the invite chip goes up from the pipeline's tagged final agent line — the
 *    browser never runs `show_test_address` itself;
 *  - hang-up drains the goodbye before the client stops, and the worklet's
 *    delivered capture is written;
 *  - a refused connect shows the demo's unavailable state and opens ZERO
 *    managed sessions: no `/api/voice-token`, no `agents.assemblyai.com`.
 *
 * It is not a live vendor run: one `delivered` leg, no `reference` or
 * `platform` leg, kind `browser-delivery`. Its artifact is a browser-delivery
 * artifact, not a cutover artifact.
 */

test.use(DEMO_TEST_USE);

/** Where the harness puts its working artifacts; CI uploads this directory. */
const ARTIFACT_DIR = process.env.VONI_E2E_ARTIFACT_DIR ?? "";

/** The cascade mint the fake route answers with; the wsUrl is intercepted. */
const DEMO_WS = "wss://pipeline.invalid/v1/browser-call";
const DEMO_CALL_ID = "call_demo_e2e_16";
const DEMO_CALL_TOKEN = "ct1.e2e";
const DEMO_AGENT = "demo:audrey";
/** The tag the fixture's invite line carries; the mint must return the same. */
const SCRIPT_TAG = loadScriptedService().testTag ?? "";

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

/** The exact cascade contract from ticket 09; a managed shape never validates. */
const MINT_RESPONSE = {
  engine: "cascade" as const,
  wsUrl: DEMO_WS,
  agentId: DEMO_AGENT,
  callToken: DEMO_CALL_TOKEN,
  demoCallToken: `${DEMO_CALL_ID}.1893456000.tag.mac`,
  testTag: SCRIPT_TAG,
  tagToken: "tag-token-e2e",
  tagCarried: false,
  maxSessionSeconds: 720,
};

type MintedRequest = {
  body: Record<string, unknown>;
  url: string;
};

/**
 * The demo's one door, faked. Registered AFTER the offline catch-all so it
 * wins (Playwright runs the most recently added matching handler first).
 */
async function mockDemoMint(page: Page) {
  const requests: MintedRequest[] = [];
  await page.route("**/api/demo/token", async (route) => {
    requests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      url: route.request().url(),
    });
    return route.fulfill({ json: MINT_RESPONSE });
  });
  return requests;
}

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

test("the landing demo runs a real cascade call, and the pipeline's invite tool reaches the UI", async ({
  page,
}, testInfo) => {
  const captures: { name: string; bytes: Buffer }[] = [];
  const vendorRequests: string[] = [];
  const managedSockets: string[] = [];
  const voiceTokenRequests: string[] = [];
  const pageErrors: string[] = [];
  const sounds: { url: string; at: number }[] = [];

  // Every app route is offline in this seam; the fake serves voice. Register
  // the catch-all first: Playwright runs the most recently added matching
  // handler, so the capture sink and the mint below must come after it.
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
  const mintRequests = await mockDemoMint(page);
  // The demo's inbox poll may ask; the pipeline owns the real tools, so the
  // browser only ever polls. "Not yet" keeps the invite up without a find.
  await page.route("**/api/demo/tools/*", (route) =>
    route.fulfill({ json: { ok: true, data: { status: "not_arrived", instructions: "Not yet." } } }),
  );
  // Live guard (ticket 151's rule enforced from this side too): the browser E2E
  // must not reach a vendor host, and a frame that tries is named below.
  await page.route(
    /(api\.meta\.ai|agents\.assemblyai\.com|api\.assemblyai\.com|tts\.assemblyai\.com|cartesia\.ai)/,
    (route) => {
      vendorRequests.push(route.request().url());
      return route.abort();
    },
  );
  // The managed path is a distinct socket; it must never open for a demo call.
  // Recording the attempt (and closing it) makes a silent managed engine a
  // named failure instead of a quiet pass.
  await page.routeWebSocket(/agents\.assemblyai\.com/, (route) => {
    managedSockets.push(route.url());
    return route.close();
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/voice-token") voiceTokenRequests.push(request.url());
    // The connected chime is a real HTMLAudio request (call-sounds.ts), so its
    // arrival time is the browser's, not a test double's.
    if (/\/sounds\/[^/]+\/connected\.mp3$/.test(url.pathname)) {
      sounds.push({ url: request.url(), at: Date.now() });
    }
  });

  const script = recordedCall();
  expect(SCRIPT_TAG, "the fixture names the call's Test tag").not.toBe("");
  const fake = await fakeCascadeServer(page, script);
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // The PUBLIC landing page. `?delivercapture=1` turns on the dev capture tap
  // the isolated test build already opted into at build time.
  await page.goto("/?delivercapture=1");
  await expect(page.getByTestId("landing-shell")).toBeVisible();

  // A click before hydration does nothing; click again, as a person would.
  const start = page.getByRole("button", { name: /^start call$/i }).filter({ visible: true }).first();
  await expect(async () => {
    if (!fake.opened()) await start.click({ timeout: 1000 }).catch(() => undefined);
    await expect.poll(fake.opened, { timeout: 3000 }).toBe(true);
  }).toPass({ timeout: 20_000 });

  // Ticket 65's contract: identity only, and the demo subject the mint named.
  // A leaked prompt, tool list or pipeline would be a client regression.
  await expect.poll(() => fake.config() !== null).toBe(true);
  const config = fake.config() as Record<string, unknown>;
  expect(Object.keys(config).sort()).toEqual(
    ["agentId", "callToken", "protocolVersion", "type"].sort(),
  );
  expect(config.type).toBe("config");
  expect(config.agentId).toBe(DEMO_AGENT);
  expect(config.callToken).toBe(DEMO_CALL_TOKEN);
  expect(config.protocolVersion).toBe(1);

  // The demo's one door: one mint, the voice the picker shows, a cascade
  // response — and no engine choice in the request.
  expect(mintRequests, "the demo minted exactly once").toHaveLength(1);
  expect(mintRequests[0]!.body).toEqual({ voiceId: "audrey" });

  // The mint above landed and the demo painted its connected state before the
  // service speaks, exactly as a live call would.
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible({ timeout: 15_000 });

  // ── The greeting is a caption the caller can read ────────────────────────
  const greeting = script.find(
    (entry) => entry.frame.type === "caption" && entry.frame.role === "agent" && entry.frame.final === true,
  );
  expect(greeting, "the script opens with an agent greeting caption").toBeTruthy();
  const greetingText = String(greeting!.frame.text);

  // ── The pipeline's server-side tool puts the invite chip up ─────────────
  // The fake plays the service's half: the tagged final line the pipeline's
  // `show_test_address` call produces. The browser must not run that tool.
  const invite = script.find((entry) => entry.tool === "show_test_address");
  expect(invite, "the script carries the pipeline's show_test_address line").toBeTruthy();
  expect(String(invite!.frame.text), "the line carries the call's Test tag").toContain(SCRIPT_TAG);

  // The scripted service speaks, is barged in on and runs its invite tool;
  // then the service hangs up. Play up to the goodbye so the chip is asserted
  // while the call is live — it is shown from the invite until the call ends.
  const beforeEnd = script.filter((entry) => entry.frame.type !== "end_call");
  const endFrames = script.filter((entry) => entry.frame.type === "end_call");
  expect(endFrames, "the script ends with one end_call").toHaveLength(1);
  await fake.play(beforeEnd);
  await expect
    .poll(() => fake.audioFrames(), { message: "the real mic path sent audio" })
    .toBeGreaterThan(0);

  await expect(page.getByText(greetingText).first()).toBeVisible();
  const chip = page.getByTestId("demo-address-chip");
  await expect(chip, "the invite chip appears from the tagged agent line").toBeVisible();
  await expect(chip).toContainText("test@voni.cc");
  await expect(chip).toContainText(SCRIPT_TAG);
  expect(
    fake.frames.filter((frame) => frame.type === "tool"),
    "the browser never runs the demo's show tool itself",
  ).toEqual([]);

  // The service hangs up; the client drains the goodbye before it stops.
  await fake.play(endFrames);
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

  const tones = { greeting: replyToneHz("greeting", script), second: replyToneHz("second", script) };
  const windows = analyse(wav, tones);

  for (const reply of ["greeting", "second"] as const) {
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
  const greetingSeconds = secondsOf(windows, "greeting");
  expect(greetingSeconds, "the interrupted greeting was actually sounding").toBeGreaterThan(0.1);
  expect(
    greetingSeconds * 1000,
    `the barge-in cut the greeting within realCutMs (${REAL_CUT_MS}ms) of the caller's ${Math.round(elapsedToCut * 1000)}ms of speech`,
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
    "the second reply follows the greeting",
  ).toBeGreaterThan(windows.findIndex((window) => window.reply === "greeting"));

  // ── Cushion and drift do not modulate the voice ─────────────────────────
  // The worklet's contract: the cushion is not a gain, and drift correction is
  // a rate adjustment bounded at ±1%. A constant tone therefore stays at a
  // constant level and pitch; pumping or a wider pitch swing fails here.
  for (const reply of ["greeting", "second"] as const) {
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
  expect(drainMs, "the goodbye played through before the client hung up").toBeGreaterThan(
    scriptedSecond * 1000 * 0.8,
  );
  expect(drainMs, "and the line was not held after it").toBeLessThan(8000);
  expect(secondReplySeconds, "the capture contains the whole goodbye").toBeGreaterThan(
    scriptedSecond * 0.8,
  );
  // The capture was written by the hang-up, so it can only be complete if the
  // drain finished first: one file, and the wire saw the goodbye.
  expect(uniqueAudioSeconds(script), "the script had unique audio to deliver").toBeGreaterThan(0);

  // ── The demo never opened a managed session ─────────────────────────────
  expect(managedSockets, "no managed socket was opened").toEqual([]);
  expect(voiceTokenRequests, "no managed token was requested").toEqual([]);

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
    call: {
      surface: "landing-demo",
      callId: DEMO_CALL_ID,
      agentId: DEMO_AGENT,
      testTag: SCRIPT_TAG,
    },
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
      greetingCaption: greetingText,
      inviteLine: String(invite!.frame.text),
      firstReplySeconds: Number(greetingSeconds.toFixed(3)),
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

  // ── The call evidence the fake exposes ──────────────────────────────────
  // The trace is the fake's side of the wire, keyed by the call id the mint
  // named: the identity-only config, every service frame it sent (with the
  // script's labels), every client frame, and the observed outcomes. It is a
  // record of this run, not a claim about a live service.
  const trace = {
    kind: "demo-cascade-browser-trace",
    schemaVersion: 1,
    pipeline: "cascade",
    surface: "landing-demo",
    callId: DEMO_CALL_ID,
    agentId: DEMO_AGENT,
    testTag: SCRIPT_TAG,
    recordedAt: new Date().toISOString(),
    config,
    mint: { requests: mintRequests },
    serviceFrames: fake.sent.map(({ at, frame }) => ({ at, ...frame })),
    clientFrames: fake.frames.map(({ at, ...frame }) => ({ at, ...frame })),
    audioFramesFromMic: fake.audioFrames(),
    deliveredCapture: "browser-delivered.wav",
    observed: {
      greetingCaption: greetingText,
      inviteTool: { name: "show_test_address", line: String(invite!.frame.text), source: "pipeline" },
      inviteChip: { address: "test@voni.cc", tag: SCRIPT_TAG, visible: true },
      bargeInToNextReplyMs: interruptedAt! - firstAudioAt!,
      endedState: "ended",
      stopAt: fake.stopAt(),
      endCallAt,
    },
    managed: { sockets: managedSockets, voiceTokenRequests },
  };
  writeFileSync(resolve(dir, "demo-call-trace.json"), `${JSON.stringify(trace, null, 2)}\n`);

  // A live vendor run is exactly what this is not.
  expect(vendorRequests, "no vendor host was contacted").toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(fake.frames.map((frame) => frame.type)).toContain("stop");
});

/**
 * The refused connect (demo-cascade ticket 11, proven by ticket 16's rig).
 *
 * The pipeline can refuse a demo at the socket — draining for a deploy, the
 * routing switch off, a protocol mismatch. The demo has no managed fallback:
 * the visitor sees the one vendor-free unavailable line, and ZERO managed
 * sessions open. The two managed tells are recorded here, not inferred: a
 * `/api/voice-token` request and an `agents.assemblyai.com` socket. Either one
 * fails the test by name, so a demo that silently used the managed engine
 * cannot pass this rig.
 */
test("a refused cascade connect shows the demo unavailable state and opens no managed session", async ({
  page,
}, testInfo) => {
  const managedSockets: string[] = [];
  const voiceTokenRequests: string[] = [];
  const vendorRequests: string[] = [];
  const pageErrors: string[] = [];
  const sounds: string[] = [];
  const captures: Buffer[] = [];

  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: { error: "offline in e2e" } }),
  );
  await page.route("**/api/dev/delivered-capture**", async (route) => {
    const bytes = route.request().postDataBuffer();
    if (bytes) captures.push(bytes);
    await route.fulfill({ json: { path: "captured-by-the-e2e-harness" } });
  });
  const mintRequests = await mockDemoMint(page);
  await page.route(
    /(api\.meta\.ai|agents\.assemblyai\.com|api\.assemblyai\.com|tts\.assemblyai\.com|cartesia\.ai)/,
    (route) => {
      vendorRequests.push(route.request().url());
      return route.abort();
    },
  );
  await page.routeWebSocket(/agents\.assemblyai\.com/, (route) => {
    managedSockets.push(route.url());
    return route.close();
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/voice-token") voiceTokenRequests.push(request.url());
    if (/\/sounds\/[^/]+\/connected\.mp3$/.test(url.pathname)) sounds.push(request.url());
  });

  const fake = await fakeCascadeServer(page, []);
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/?delivercapture=1");
  await expect(page.getByTestId("landing-shell")).toBeVisible();
  const start = page.getByRole("button", { name: /^start call$/i }).filter({ visible: true }).first();
  await expect(async () => {
    if (!fake.opened()) await start.click({ timeout: 1000 }).catch(() => undefined);
    await expect.poll(fake.opened, { timeout: 3000 }).toBe(true);
  }).toPass({ timeout: 20_000 });

  // The cascade client sent identity only, then the service refused the call
  // with its routing verdict (`managed`): the exact refusal the demo must not
  // answer with a managed handover.
  await expect.poll(() => fake.config() !== null).toBe(true);
  const config = fake.config() as Record<string, unknown>;
  expect(config.agentId).toBe(DEMO_AGENT);
  expect(config.callToken).toBe(DEMO_CALL_TOKEN);
  fake.say({
    type: "error",
    code: "managed",
    message: "The voice service routes this call to the managed engine.",
  });

  // The visitor-facing state: one line, no engine/vendor language, and the
  // call is over — never a second transport.
  const unavailable = page.getByTestId("demo-unavailable");
  await expect(unavailable).toBeVisible({ timeout: 10_000 });
  await expect(unavailable).toContainText(DEMO_UNAVAILABLE_MESSAGES.managed);
  await expect(page.locator('[data-voice-state="ended"]')).toBeVisible();

  // The demo minted once. A managed fallback would fetch another credential
  // and open the managed socket; neither happened.
  expect(mintRequests, "the demo minted exactly once").toHaveLength(1);
  expect(voiceTokenRequests, "no managed token was requested").toEqual([]);
  expect(managedSockets, "no managed socket was opened").toEqual([]);
  expect(vendorRequests, "no vendor host was contacted").toEqual([]);
  expect(sounds, "no audio ever sounded, so the chime stayed silent").toEqual([]);
  expect(captures, "a call with no audible sample writes no capture").toEqual([]);
  expect(pageErrors).toEqual([]);

  // The refused call is evidence too: the artifact records what was refused
  // and the zero counts the assertions above just proved.
  const dir = ARTIFACT_DIR ? resolve(ARTIFACT_DIR) : testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "demo-unavailable.json"),
    `${JSON.stringify(
      {
        kind: "demo-cascade-refusal",
        schemaVersion: 1,
        pipeline: "cascade",
        surface: "landing-demo",
        recordedAt: new Date().toISOString(),
        command: "node scripts/e2e-run.mjs cascade",
        refusal: { code: "managed", source: "service" },
        observed: {
          state: "ended",
          message: DEMO_UNAVAILABLE_MESSAGES.managed,
          mintRequests: mintRequests.length,
          managedSockets,
          voiceTokenRequests,
          vendorRequests,
          audibleSamples: sounds.length,
          captures: captures.length,
        },
        managedFallback: false,
      },
      null,
      2,
    )}\n`,
  );
});
