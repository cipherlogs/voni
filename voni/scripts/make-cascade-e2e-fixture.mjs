#!/usr/bin/env node
// Regenerate the committed scripted-service fixture for the browser E2E seam
// (ticket 149). The frames follow the wire contract in
// `voice-pipeline/transport.py`; the audio is a deterministic 440 Hz tone, so
// the delivered capture's length is derived from the script rather than from
// wall-clock luck. This is a scripted service, not a vendor recording.
//
//   node scripts/make-cascade-e2e-fixture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 24_000;
const FRAME_SECONDS = 0.3;
const FRAMES = 4;

function toneFrame({ seconds = FRAME_SECONDS, hz = 440, amplitude = 0.25 } = {}) {
  const frames = Math.round(SAMPLE_RATE * seconds);
  const bytes = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude;
    bytes.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return bytes.toString("base64");
}

const audio = toneFrame();
const document = {
  schemaVersion: 1,
  note:
    "Scripted cascade service frames for the browser E2E (ticket 149). The " +
    "frame shapes follow voice-pipeline/transport.py; the audio is a " +
    "deterministic 440 Hz tone, not a vendor recording. Regenerate with " +
    "`node scripts/make-cascade-e2e-fixture.mjs`.",
  sampleRate: SAMPLE_RATE,
  audioSeconds: FRAMES * FRAME_SECONDS,
  frames: [
    { afterMs: 0, frame: { type: "caption", role: "user", text: "I want to book a viewing.", final: true } },
    { afterMs: 0, frame: { type: "caption", role: "agent", text: "Sure — one moment.", final: true } },
    ...Array.from({ length: FRAMES }, () => ({
      afterMs: 0,
      frame: { type: "audio", data: audio, sample_rate: SAMPLE_RATE },
    })),
    { afterMs: 0, frame: { type: "end_call" } },
  ],
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/e2e/fixtures/cascade-call.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${out}`);
