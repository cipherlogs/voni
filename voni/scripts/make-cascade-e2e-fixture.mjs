#!/usr/bin/env node
// Regenerate the committed scripted-service fixture for the browser E2E seam
// (ticket 149, extended by ticket 150). The frames follow the wire contract in
// `voice-pipeline/transport.py`; the audio is a deterministic tone, so the
// delivered capture's length, pitch and cut point are derived from the script
// rather than from wall-clock luck. This is a scripted service, not a vendor
// recording.
//
// Ticket 150 gives each audio frame the call-level `seq` ticket 98 defines and
// scripts the behaviours only a browser can prove:
//
//   first reply (440 Hz, seq 1-6)  -> interrupted 300ms in
//   second reply (730 Hz, seq 7-9) -> the same 7,8 replayed (a duplicate)
//   end_call                       -> the goodbye drains
//
// The source rate is 16 kHz, deliberately not the client's 24 kHz default: a
// client that ignores the frame's stamped rate plays this 3/2 fast at the
// wrong pitch, and the capture says so.
//
//   node scripts/make-cascade-e2e-fixture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 16_000;
const FRAME_SECONDS = 0.4;
const FIRST_REPLY_FRAMES = 6;
const SECOND_REPLY_FRAMES = 3;
/** The barge-in lands after this much wall-clock audio has been queued. */
const INTERRUPT_AFTER_MS = 500;

function toneFrame({ seconds = FRAME_SECONDS, hz, amplitude = 0.25 } = {}) {
  const frames = Math.round(SAMPLE_RATE * seconds);
  const bytes = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude;
    bytes.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return bytes.toString("base64");
}

const first = toneFrame({ hz: 440 });
const second = toneFrame({ hz: 730 });

/** One audio frame: the wire shape plus the script's own labelling. */
function audio({ seq, data, hz, reply, duplicate = false }) {
  return {
    afterMs: 0,
    reply,
    hz,
    ...(duplicate ? { duplicate: true } : {}),
    frame: { type: "audio", data, sample_rate: SAMPLE_RATE, seq },
  };
}

const document = {
  schemaVersion: 1,
  note:
    "Scripted cascade service frames for the browser E2E (tickets 149/150). " +
    "The frame shapes follow voice-pipeline/transport.py; the audio is a " +
    "deterministic tone, not a vendor recording. `reply`, `hz` and " +
    "`duplicate` are the script's own labels, never sent on the wire. " +
    "Regenerate with `node scripts/make-cascade-e2e-fixture.mjs`.",
  sampleRate: SAMPLE_RATE,
  /** Unique audio the service meant the caller to hear, once each. */
  audioSeconds: (FIRST_REPLY_FRAMES + SECOND_REPLY_FRAMES) * FRAME_SECONDS,
  interruptAfterMs: INTERRUPT_AFTER_MS,
  frames: [
    {
      afterMs: 0,
      frame: {
        type: "caption",
        role: "user",
        text: "I want to book a viewing, but hold on a second.",
        final: true,
      },
    },
    {
      afterMs: 0,
      frame: { type: "caption", role: "agent", text: "Sure — the 25th works.", final: true },
    },
    ...Array.from({ length: FIRST_REPLY_FRAMES }, (_, i) =>
      audio({ seq: i + 1, data: first, hz: 440, reply: "first" }),
    ),
    { afterMs: INTERRUPT_AFTER_MS, frame: { type: "interrupted" } },
    ...Array.from({ length: SECOND_REPLY_FRAMES }, (_, i) =>
      audio({ seq: FIRST_REPLY_FRAMES + i + 1, data: second, hz: 730, reply: "second" }),
    ),
    // A replay: the same seq and bytes arrive again. The playout contract is a
    // frame not newer than the highest played is dropped, so these add silence.
    audio({ seq: FIRST_REPLY_FRAMES + 1, data: second, hz: 730, reply: "second", duplicate: true }),
    audio({ seq: FIRST_REPLY_FRAMES + 2, data: second, hz: 730, reply: "second", duplicate: true }),
    { afterMs: 0, frame: { type: "end_call" } },
  ],
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/e2e/fixtures/cascade-call.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${out}`);
