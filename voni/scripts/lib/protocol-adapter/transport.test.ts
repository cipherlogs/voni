/**
 * The transport's cadence and received PCM, without a vendor or a browser.
 *
 * A scripted socket stands in for the pipeline; the real app signing, delivery,
 * frame encoding, ingress pump and received-audio capture are the production
 * code. The clock is virtual, so the test can pin that every caller frame is
 * the browser's 128 samples and that the received PCM is written verbatim.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCorpus } from "@/lib/demo/verification/scenarios";
import { runProtocolCall } from "./transport";
import { removeTree, writeCorpus } from "./fixtures";

// The demo body always names its model (owner decision 2026-11-03), so the
// builder reads the Meta key the override carries. This is a fake; the
// scripted socket never reaches a vendor.
process.env.META_API_KEY = "test-meta-key";
delete process.env.DEMO_LLM_MODEL_OVERRIDE;

function audioMessage(samples = 128): string {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(100, index * 2);
  }
  return JSON.stringify({ type: "audio", data: pcm.toString("base64"), sample_rate: 24_000 });
}

function socketScript(input: {
  readonly endAtFrame: number;
  readonly dropAtFrame?: number;
  /** End on the caller's stop frame, as the live service does. */
  readonly endOnStop?: boolean;
}) {
  const sent: string[] = [];
  const audioBytes: number[] = [];
  let message: ((raw: string) => void) | null = null;
  let close: (() => void) | null = null;
  let error: ((raw: string) => void) | null = null;
  let audioFrames = 0;
  let ended = false;

  return {
    sent,
    audioBytes,
    socket: {
      send(data: string): void {
        sent.push(data);
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed.type === "stop" && input.endOnStop === true && !ended) {
          ended = true;
          message?.(JSON.stringify({ type: "end", turns: 1, endedBy: "stop", metrics: { marks: {} } }));
          queueMicrotask(() => close?.());
          return;
        }
        if (parsed.type !== "audio" || typeof parsed.data !== "string") return;
        audioBytes.push(Buffer.from(parsed.data, "base64").length);
        audioFrames += 1;
        if (audioFrames === 1) message?.(audioMessage());
        if (audioFrames === 3) {
          message?.(JSON.stringify({ type: "caption", role: "agent", text: "Hi", final: false }));
        }
        if (audioFrames === input.endAtFrame && !ended) {
          ended = true;
          message?.(JSON.stringify({ type: "end", turns: 1, metrics: { marks: {} } }));
          queueMicrotask(() => close?.());
        }
      },
      close(): void {
        close?.();
      },
      onOpen(handler: () => void): void {
        queueMicrotask(() => handler());
      },
      onMessage(handler: (data: string) => void): void {
        message = handler;
      },
      onError(handler: (raw: string) => void): void {
        error = handler;
      },
      onClose(handler: () => void): void {
        close = handler;
      },
    },
    fail(raw: string): void {
      error?.(raw);
    },
  };
}

async function loadedScenario(root: string, faults: readonly Record<string, unknown>[] = []) {
  const dir = join(root, "corpus");
  writeCorpus(dir, [
    {
      name: "golden-flow-smoke",
      faults: faults as never,
    },
  ]);
  const corpus = await loadCorpus({ dir, knownProperties: new Set(["G1", "E1"]) });
  const scenario = corpus.scenarios[0];
  assert.ok(scenario !== undefined);
  return scenario;
}

test("caller audio is streamed at the browser cadence and received PCM is captured", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv11-transport-"));
  const previous = process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
  process.env.VOICE_PIPELINE_ENVELOPE_SECRET = "test-envelope";
  try {
    const scenario = await loadedScenario(root);
    const script = socketScript({ endAtFrame: 40 });
    let t = 0;
    const result = await runProtocolCall(
      {
        scenario,
        callId: "11111111-1111-4111-8111-111111111111",
        target: {
          httpBase: "http://127.0.0.1:8767",
          wsUrl: "ws://127.0.0.1:8767/v1/browser-call",
          local: true,
        },
        targetLabel: "local",
        soundscapePcm: null,
        timeoutMs: 5_000,
        env: process.env,
      },
      {
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            signed_body: { envelope: { call_id: string; agent_id: string; body_hash: string } };
          };
          const envelope = body.signed_body.envelope;
          return new Response(
            JSON.stringify({
              status: "accepted",
              call_id: envelope.call_id,
              agent_id: envelope.agent_id,
              body_hash: envelope.body_hash,
            }),
            { status: 202 },
          );
        }) as typeof fetch,
        connect: () => script.socket,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );

    const config = JSON.parse(script.sent[0] ?? "{}") as Record<string, unknown>;
    assert.equal(config.type, "config");
    assert.equal(config.agentId, "demo:audrey");
    assert.equal(typeof config.callToken, "string");

    assert.ok(result.caller.frames > 100, "the mic pumps for the whole call, not in bursts");
    assert.equal(result.caller.frameBytes, 256);
    assert.ok(
      script.audioBytes.every((bytes) => bytes === 256),
      "every caller frame is 128 samples (256 bytes) at 24 kHz",
    );
    assert.ok(result.received.bytes > 0, "agent audio is kept for the run's WAV");
    assert.equal(result.endedBy, "end");
    assert.ok(result.timeline.events.some((event) => event.type === "call-open"));
    assert.ok(result.timeline.events.some((event) => event.type === "agent-speech-start"));
    assert.deepEqual(result.triggerPlan.unresolved, []);
    assert.equal(result.triggerPlan.points[0]?.take, "opening");
  } finally {
    if (previous === undefined) delete process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
    else process.env.VOICE_PIPELINE_ENVELOPE_SECRET = previous;
    removeTree(root);
  }
});

test("a call-drop fault closes the call at its point and records that ending", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv11-transport-drop-"));
  const previous = process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
  process.env.VOICE_PIPELINE_ENVELOPE_SECRET = "test-envelope";
  try {
    const scenario = await loadedScenario(root, [{ kind: "call-drop", atMs: 300 }]);
    const script = socketScript({ endAtFrame: 500 });
    let t = 0;
    const result = await runProtocolCall(
      {
        scenario,
        callId: "11111111-1111-4111-8111-111111111111",
        target: {
          httpBase: "http://127.0.0.1:8767",
          wsUrl: "ws://127.0.0.1:8767/v1/browser-call",
          local: true,
        },
        targetLabel: "local",
        soundscapePcm: null,
        timeoutMs: 5_000,
        env: process.env,
      },
      {
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            signed_body: { envelope: { call_id: string; agent_id: string; body_hash: string } };
          };
          const envelope = body.signed_body.envelope;
          return new Response(
            JSON.stringify({
              status: "accepted",
              call_id: envelope.call_id,
              agent_id: envelope.agent_id,
              body_hash: envelope.body_hash,
            }),
            { status: 202 },
          );
        }) as typeof fetch,
        connect: () => script.socket,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );

    assert.equal(result.endedBy, "fault-call-drop");
    assert.equal(result.faultsApplied[0]?.kind, "call-drop");
    assert.match(result.faultsApplied[0]?.observed ?? "", /closed at the fault point/);
    assert.ok(result.received.bytes <= 256, "agent audio stops at the drop point");
  } finally {
    if (previous === undefined) delete process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
    else process.env.VOICE_PIPELINE_ENVELOPE_SECRET = previous;
    removeTree(root);
  }
});

test("a graceful end before the call-drop point is not reported as a drop", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv11-transport-early-end-"));
  const previous = process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
  process.env.VOICE_PIPELINE_ENVELOPE_SECRET = "test-envelope";
  try {
    const scenario = await loadedScenario(root, [{ kind: "call-drop", atMs: 5_000 }]);
    const script = socketScript({ endAtFrame: 40 });
    let t = 0;
    const result = await runProtocolCall(
      {
        scenario,
        callId: "11111111-1111-4111-8111-111111111111",
        target: {
          httpBase: "http://127.0.0.1:8767",
          wsUrl: "ws://127.0.0.1:8767/v1/browser-call",
          local: true,
        },
        targetLabel: "local",
        soundscapePcm: null,
        timeoutMs: 5_000,
        env: process.env,
      },
      {
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            signed_body: { envelope: { call_id: string; agent_id: string; body_hash: string } };
          };
          const envelope = body.signed_body.envelope;
          return new Response(
            JSON.stringify({
              status: "accepted",
              call_id: envelope.call_id,
              agent_id: envelope.agent_id,
              body_hash: envelope.body_hash,
            }),
            { status: 202 },
          );
        }) as typeof fetch,
        connect: () => script.socket,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );

    assert.equal(result.endedBy, "end");
    assert.match(result.faultsApplied[0]?.observed ?? "", /ended before the fault point/);
  } finally {
    if (previous === undefined) delete process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
    else process.env.VOICE_PIPELINE_ENVELOPE_SECRET = previous;
    removeTree(root);
  }
});

test("a script with no hang-up stops the call instead of dropping the socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "dv11-transport-stop-"));
  const previous = process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
  process.env.VOICE_PIPELINE_ENVELOPE_SECRET = "test-envelope";
  try {
    const scenario = await loadedScenario(root);
    const script = socketScript({ endAtFrame: Number.MAX_SAFE_INTEGER, endOnStop: true });
    let t = 0;
    const result = await runProtocolCall(
      {
        scenario,
        callId: "22222222-2222-4222-8222-222222222222",
        target: {
          httpBase: "http://127.0.0.1:8767",
          wsUrl: "ws://127.0.0.1:8767/v1/browser-call",
          local: true,
        },
        targetLabel: "local",
        soundscapePcm: null,
        timeoutMs: 5_000,
        env: process.env,
      },
      {
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            signed_body: { envelope: { call_id: string; agent_id: string; body_hash: string } };
          };
          const envelope = body.signed_body.envelope;
          return new Response(
            JSON.stringify({
              status: "accepted",
              call_id: envelope.call_id,
              agent_id: envelope.agent_id,
              body_hash: envelope.body_hash,
            }),
            { status: 202 },
          );
        }) as typeof fetch,
        connect: () => script.socket,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );

    const stop = script.sent.filter((raw) => (JSON.parse(raw) as { type?: string }).type === "stop");
    assert.equal(stop.length, 1, "exactly one stop frame ends the call");
    assert.equal(result.endedBy, "end", "the service ended on the stop frame, not by a close");
    assert.equal(result.error, null, "a clean stop is not an error");
  } finally {
    if (previous === undefined) delete process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
    else process.env.VOICE_PIPELINE_ENVELOPE_SECRET = previous;
    removeTree(root);
  }
});
