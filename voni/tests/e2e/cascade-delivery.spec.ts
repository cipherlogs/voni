import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

import { DEMO_TEST_USE } from "./demo-fakes";
import {
  FAKE_SAMPLE_RATE,
  fakeCascadeServer,
  queuedAudioSeconds,
  recordedCall,
} from "./cascade-fake-server";

/**
 * Seam 4 (ticket 149): a real Chromium runs the real browser client
 * (`CascadeSession`), the real mic path and the real playout worklet, and the
 * service half is the deterministic fake in `./cascade-fake-server`.
 *
 * It writes a real delivered capture on every PR. Merging is what triggers
 * this: a client regression — a leaked prompt in the config, audio that never
 * reaches the worklet, a capture that is missing — fails here, before a live
 * call. It is not a live vendor run, and its artifact says so: one `delivered`
 * leg, no `reference` or `platform` leg, kind `browser-delivery`.
 */

test.use(DEMO_TEST_USE);

/** Where the harness puts its working artifacts; CI uploads this directory. */
const ARTIFACT_DIR = process.env.VONI_E2E_ARTIFACT_DIR ?? "";

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

function peak(samples: Int16Array): number {
  let max = 0;
  for (const sample of samples) max = Math.max(max, Math.abs(sample));
  return max;
}

test("a real cascade call writes a delivered capture, with no vendor in the path", async ({
  page,
}, testInfo) => {
  const captures: { name: string; bytes: Buffer }[] = [];
  const vendorRequests: string[] = [];
  const pageErrors: string[] = [];

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
    /(api\.meta\.ai|agents\.assemblyai\.com|api\.assemblyai\.com|tts\.us\.assemblyai\.com|cartesia\.ai)/,
    (route) => {
      vendorRequests.push(route.request().url());
      return route.abort();
    },
  );

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

  // The scripted service speaks and then hangs up; the client drains the
  // goodbye through the real worklet before it stops.
  await fake.play();
  await expect
    .poll(() => fake.audioFrames(), { message: "the real mic path sent audio" })
    .toBeGreaterThan(0);
  await expect
    .poll(() => captures.length, { message: "the delivered capture was written", timeout: 20_000 })
    .toBe(1);
  await expect.poll(() => fake.stopAt(), { timeout: 10_000 }).not.toBeNull();
  await expect(page.locator('[data-voice-state="ended"]')).toBeVisible();

  // A real WAV at the worklet's output rate, mono 16-bit, with the queued
  // audio present: the tap is after the worklet, not a copy of the wire.
  const capture = captures[0]!;
  const wav = parseWav(capture.bytes);
  expect(wav.audioFormat, "PCM").toBe(1);
  expect(wav.channels, "mono").toBe(1);
  expect(wav.bitsPerSample, "16-bit").toBe(16);
  expect(wav.sampleRate, "the worklet's device rate").toBeGreaterThanOrEqual(FAKE_SAMPLE_RATE);

  const queued = queuedAudioSeconds(script);
  // Lower bound: every queued frame reached the worklet. Upper bound: the
  // pre-roll, mic startup and the 250 ms drain poll, not a runtime budget.
  expect(wav.seconds, "all queued agent audio was delivered").toBeGreaterThanOrEqual(queued);
  expect(wav.seconds, "the capture stopped with the call").toBeLessThan(queued + 6);
  expect(peak(wav.samples), "the delivered tone is audible").toBeGreaterThan(1000);

  // The artifact is a browser-delivery artifact, not a cutover artifact.
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
    /** One leg only: this run never observed a reference or platform capture. */
    legs: ["delivered"],
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
