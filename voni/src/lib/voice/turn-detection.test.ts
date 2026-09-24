import test from "node:test";
import assert from "node:assert/strict";
import { buildInlineSessionUpdate, TURN_PRESET, VoiceSession } from "./session";

(globalThis as unknown as { WebSocket: unknown }).WebSocket = { OPEN: 1 };

test("turn preset: fast confident endpoint, capped unclear wait, backchannel-proof barge-in", () => {
  assert.deepEqual(TURN_PRESET, {
    min_silence: 150,
    max_silence: 450,
    interrupt_response: true,
    interruption_delay: 200,
  });
});

test("inline sessions get the turn preset without passing it", () => {
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "p",
    greeting: "hi",
    voiceId: "v",
  });
  assert.deepEqual(
    (update as { input: { turn_detection: unknown } }).input.turn_detection,
    TURN_PRESET,
  );
});

test("bound demo agents get the turn preset right after session.ready", () => {
  const session = new VoiceSession();
  const sent: string[] = [];
  const internals = session as unknown as Record<string, unknown>;
  internals["ws"] = { readyState: 1, send: (m: string) => sent.push(m) };
  internals["boundAgent"] = true;
  const handle = (m: Record<string, unknown>) =>
    (session as unknown as { handle: (raw: string) => void }).handle(JSON.stringify(m));

  handle({ type: "session.ready", session_id: "sess_1" });
  assert.deepEqual(JSON.parse(sent[0]), {
    type: "session.update",
    session: { input: { transcription_mode: "min_latency", turn_detection: TURN_PRESET } },
  });
  handle({ type: "session.updated" });
  // A resume re-emits session.ready; the server keeps config, so no resend.
  handle({ type: "session.ready", session_id: "sess_1" });
  assert.equal(sent.length, 1);
});

test("barge-in fades the reply gain to 0 over 40ms, then a fresh gain takes over", () => {
  const session = new VoiceSession();
  const internals = session as unknown as Record<string, unknown>;
  const ramps: [string, number, number][] = [];
  const stops: number[] = [];
  let gains = 0;
  const ctx = {
    currentTime: 10,
    destination: {},
    createGain: () => {
      gains += 1;
      return {
        gain: {
          value: 1,
          setValueAtTime: (v: number, t: number) => ramps.push(["set", v, t]),
          linearRampToValueAtTime: (v: number, t: number) => ramps.push(["ramp", v, t]),
        },
        connect: () => undefined,
        disconnect: () => undefined,
      };
    },
    createBuffer: (_c: number, n: number, rate: number) => ({
      duration: n / rate,
      getChannelData: () => new Float32Array(n),
    }),
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect: () => undefined,
      start: () => undefined,
      stop: (t: number) => stops.push(t),
      disconnect: () => undefined,
    }),
  };
  internals["audioCtx"] = ctx;
  const schedule = (session as unknown as { schedule: (b64: string) => void }).schedule.bind(session);
  const chunk = Buffer.from(new Uint8Array(480)).toString("base64");

  schedule(chunk);
  schedule(chunk);
  assert.equal(gains, 1, "chunks of one reply share one gain");

  (session as unknown as { flush: () => void }).flush();
  assert.deepEqual(ramps, [["set", 1, 10], ["ramp", 0, 10.04]]);
  assert.deepEqual(stops, [10.04, 10.04]);
  assert.equal(internals["playhead"], 10.04, "next reply never overlaps the fade");

  schedule(chunk);
  assert.equal(gains, 2, "next reply starts on a fresh unity gain");
});
