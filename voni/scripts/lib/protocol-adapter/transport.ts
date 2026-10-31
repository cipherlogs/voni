/**
 * The real protocol call: `POST /v1/call-body`, then one browser-call socket.
 *
 * This is the existing live harness's seam (`scripts/lib/real-legs.ts`) with the
 * scenario runtime around it: caller takes are queued by trigger rule, the mic
 * pump keeps the browser's 128-sample cadence, the soundscape is mixed under the
 * uplink, the scenario's faults are applied at the media seam, and every agent
 * audio frame is kept so the run can write its own received PCM.
 *
 * There is no browser and no retry. One scenario produces one call.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "One seam, two adapters".
 */

import { readFileSync } from "node:fs";

import { buildDemoCascadeBody } from "@/lib/demo/cascade-body";
import { deliverCallBody } from "@/lib/demo/pipeline-delivery";
import {
  CASCADE_PROTOCOL_VERSION,
  buildConfigMessage,
  decodeAudioMessage,
  encodeAudioFrame,
  parseServerMessage,
} from "@/lib/voice/cascade-session";
import {
  assertTriggersResolved,
  evaluateTriggers,
  type AgentTimelineEvent,
  type Locale,
  type ScriptStep,
  type TriggerRule,
} from "@/lib/demo/verification/scenarios";

import {
  INGRESS_FRAME_BYTES,
  INGRESS_SAMPLE_RATE,
  createIngressPump,
  decodeWavPcm,
  type RealLegsSocket,
} from "../real-legs";
import { ProtocolAdapterError } from "./errors";
import {
  appliedFaults,
  callDropAtMs,
  decideUplinkFrame,
  mixSoundscape,
} from "./faults";
import type {
  ObservedTimeline,
  ProtocolCallInput,
  ProtocolCallResult,
  ProtocolTarget,
} from "./types";

/** One call's timeout when the caller does not set one. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Agent audio quieter than this ends a burst, in call time. */
export const AGENT_QUIET_MS = 800;

/** A gap this long starts a new agent speech burst. */
export const AGENT_SPEECH_GAP_MS = 250;

/** How often the live resolver observes the socket and the quiet window. */
const POLL_MS = 25;

/** One demo voice per Locale: the voice picks the language. */
export const LOCALE_VOICES: Readonly<Record<Locale, string>> = {
  en: "audrey",
  es: "malvina",
  fr: "donatien",
  de: "jorg",
  pt: "benicio",
};

export function voiceForLocale(locale: Locale): string {
  return LOCALE_VOICES[locale];
}

export type ProtocolCallDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly connect?: (url: string) => RealLegsSocket;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function defaultNow(): number {
  return performance.now();
}

function defaultConnect(url: string): RealLegsSocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (handler) => {
      socket.onopen = () => handler();
    },
    onMessage: (handler) => {
      socket.onmessage = (event) => handler(typeof event.data === "string" ? event.data : "");
    },
    onError: (handler) => {
      socket.onerror = () => handler("the voice service socket reported an error");
    },
    onClose: (handler) => {
      socket.onclose = () => handler();
    },
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

type CallState = {
  end: Record<string, unknown> | null;
  endCallSeen: boolean;
  closed: boolean;
  error: string | null;
  timeline: AgentTimelineEvent[];
  spoken: { step: number; take: string; atMs: number }[];
  received: Uint8Array[];
  receivedFrames: number;
  capturedFrames: number;
  sentFrames: number;
  capturedBytes: number;
  sentBytes: number;
  speechOpen: boolean;
  lastAudioAtMs: number | null;
  lastSpeechEndAtMs: number | null;
};

/**
 * Run one call. The socket is opened, the signed body delivered, the caller
 * script resolved against the live agent timeline, and the call observed until
 * its end (or the scenario's call-drop fault).
 */
export async function runProtocolCall(
  input: ProtocolCallInput,
  deps: ProtocolCallDeps = {},
): Promise<ProtocolCallResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const connect = deps.connect ?? defaultConnect;
  const now = deps.now ?? defaultNow;
  const sleep = deps.sleep ?? defaultSleep;
  const scenario = input.scenario;
  const voice = voiceForLocale(scenario.locale);
  const subject = `demo:${voice}`;
  const startedAt = new Date().toISOString();
  const timeoutMs = input.timeoutMs;

  const call = await buildDemoCascadeBody({ voice, callId: input.callId }).catch(
    (error: unknown) => {
      throw new ProtocolAdapterError(
        "call-refused",
        `the app could not build and sign the demo body: ${(error as Error).message}`,
      );
    },
  );
  const delivery = await deliverCallBody(
    {
      pipelineBase: input.target.httpBase,
      callToken: call.callToken,
      callId: call.callId,
      signedBody: call.signedBody,
    },
    { fetchImpl },
  );
  if (!delivery.ok) {
    throw new ProtocolAdapterError(
      "call-refused",
      `POST ${input.target.httpBase}/v1/call-body refused: ${delivery.code} — ${delivery.message}`,
    );
  }
  if (
    delivery.callId !== call.callId ||
    delivery.agentId !== call.agentId ||
    delivery.bodyHash !== call.bodyHash
  ) {
    throw new ProtocolAdapterError(
      "call-refused",
      `the service accepted call "${delivery.callId}" for "${delivery.agentId}" with body hash ` +
        `${delivery.bodyHash}; the app sent "${call.callId}", "${call.agentId}", ${call.bodyHash}`,
    );
  }

  let socket: RealLegsSocket;
  try {
    socket = connect(input.target.wsUrl);
  } catch (error) {
    throw new ProtocolAdapterError(
      "call-refused",
      `could not open ${input.target.wsUrl}: ${(error as Error).message}`,
    );
  }

  const state: CallState = {
    end: null,
    endCallSeen: false,
    closed: false,
    error: null,
    timeline: [],
    spoken: [],
    received: [],
    receivedFrames: 0,
    capturedFrames: 0,
    sentFrames: 0,
    capturedBytes: 0,
    sentBytes: 0,
    speechOpen: false,
    lastAudioAtMs: null,
    lastSpeechEndAtMs: null,
  };

  let openAt = 0;
  const dropAt: number | null = callDropAtMs(scenario.faults);
  let dropped = false;
  /** A relayed frame waits here when jitter or endpoint latency applies. */
  const delayed: { frame: Uint8Array; due: number }[] = [];
  const faultCounts = new Map<string, number>();
  let running = true;

  const callTime = (): number => Math.max(0, now() - openAt);

  const sendFrame = (frame: Uint8Array): void => {
    if (!running) return;
    try {
      socket.send(encodeAudioFrame(frame.slice().buffer));
      state.sentFrames += 1;
      state.sentBytes += frame.byteLength;
    } catch {
      state.closed = true;
      running = false;
    }
  };

  const pump = createIngressPump({
    send: (frame) => {
      if (!running) return;
      const atMs = callTime();
      if (dropAt !== null && atMs >= dropAt) {
        dropped = true;
        faultCounts.set(`call-drop@${dropAt}`, (faultCounts.get(`call-drop@${dropAt}`) ?? 0) + 1);
        running = false;
        socket.close();
        return;
      }
      const decision = decideUplinkFrame(scenario.faults, atMs);
      if (decision.fault !== null) {
        const key = `${decision.fault.kind}@${decision.fault.atMs}`;
        faultCounts.set(key, (faultCounts.get(key) ?? 0) + 1);
      }
      if (input.soundscapePcm !== null) {
        mixSoundscape(
          frame,
          input.soundscapePcm,
          atMs,
          scenario.soundscape.levelDb,
        );
      }
      state.capturedFrames += 1;
      state.capturedBytes += frame.byteLength;
      if (!decision.send) return;
      if (decision.delayMs > 0) {
        delayed.push({ frame, due: now() + decision.delayMs });
        return;
      }
      sendFrame(frame);
    },
    now,
    sleep,
  });

  /** Flush frames whose simulated delay has elapsed. */
  const relay = (async () => {
    while (running) {
      await sleep(2);
      const due = delayed.filter((entry) => entry.due <= now());
      if (due.length === 0) continue;
      for (const entry of due) {
        const index = delayed.indexOf(entry);
        if (index >= 0) delayed.splice(index, 1);
        sendFrame(entry.frame);
      }
    }
  })();

  /** Record a quiet agent stream as speech-end and turn-end, once per burst. */
  const noteQuiet = (): void => {
    if (!state.speechOpen || state.lastAudioAtMs === null) return;
    const atMs = callTime();
    if (atMs - state.lastAudioAtMs < AGENT_QUIET_MS) return;
    const endAt = state.lastAudioAtMs + AGENT_QUIET_MS;
    state.timeline.push({ atMs: endAt, type: "agent-speech-end" });
    state.timeline.push({ atMs: endAt, type: "agent-turn-end" });
    state.lastSpeechEndAtMs = endAt;
    state.speechOpen = false;
  };

  socket.onMessage((raw) => {
    const audio = decodeAudioMessage(raw);
    if (audio !== null) {
      const atMs = callTime();
      if (
        !state.speechOpen ||
        state.lastAudioAtMs === null ||
        atMs - state.lastAudioAtMs > AGENT_SPEECH_GAP_MS
      ) {
        state.timeline.push({ atMs, type: "agent-speech-start" });
        state.speechOpen = true;
      }
      state.lastAudioAtMs = atMs;
      state.received.push(audio.pcm);
      state.receivedFrames += 1;
      return;
    }
    const event = parseServerMessage(raw);
    if (event === null) return;
    switch (event.kind) {
      case "caption":
        break;
      case "interrupted":
        break;
      case "end_call":
        state.endCallSeen = true;
        break;
      case "end":
        state.end = { type: "end", turns: event.turns, metrics: event.metrics };
        break;
      case "error":
        state.error = event.message;
        break;
      default:
        break;
    }
  });
  socket.onError((message) => {
    if (state.end === null) state.error = message;
  });
  socket.onClose(() => {
    state.closed = true;
  });

  const opened = new Promise<void>((resolvePromise) => socket.onOpen(() => resolvePromise()));
  let connectTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      opened,
      new Promise<never>((_resolve, reject) => {
        connectTimer = setTimeout(
          () =>
            reject(
              new ProtocolAdapterError(
                "call-timeout",
                `no WebSocket open on ${input.target.wsUrl} within ${timeoutMs} ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
  }

  openAt = now();
  state.timeline.push({ atMs: 0, type: "call-open" });
  const config = buildConfigMessage({
    serviceUrl: input.target.wsUrl,
    callToken: call.callToken,
    agentId: call.agentId,
    protocolVersion: CASCADE_PROTOCOL_VERSION,
  });
  socket.send(config);
  pump.start();

  /** Wait until the call reaches `targetMs`, observing the stream meanwhile. */
  async function waitUntil(targetMs: number): Promise<void> {
    const deadline = callTime() + timeoutMs;
    for (;;) {
      noteQuiet();
      if (callTime() >= targetMs) return;
      if (state.end !== null || state.closed || dropped) {
        throw new ProtocolAdapterError(
          "trigger-unresolved",
          `the call ended at ${Math.round(callTime())} ms before the caller's next cue at ` +
            `${Math.round(targetMs)} ms; a trigger that never fires is not a skip`,
        );
      }
      if (callTime() > deadline) {
        throw new ProtocolAdapterError(
          "call-timeout",
          `the caller did not reach ${Math.round(targetMs)} ms within ${timeoutMs} ms`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  /** Resolve one script step against the live timeline. */
  async function cue(step: ScriptStep, index: number): Promise<void> {
    const rule: TriggerRule = step.trigger;
    let atMs: number;
    switch (rule.type) {
      case "call-open":
        atMs = (rule.delayMs ?? 0);
        break;
      case "at-offset":
        atMs = rule.atMs;
        break;
      case "agent-speech-start":
      case "agent-turn-end": {
        const found = await waitForEvent(rule.type);
        atMs = found.atMs + (rule.delayMs ?? 0);
        break;
      }
      case "silence": {
        const found = await waitForEvent("agent-speech-end");
        atMs = found.atMs + rule.silenceMs + (rule.delayMs ?? 0);
        break;
      }
      default: {
        const exhaustive: never = rule;
        throw new ProtocolAdapterError(
          "trigger-unresolved",
          `script step ${index} names unknown trigger "${String((exhaustive as TriggerRule).type)}"`,
        );
      }
    }
    await waitUntil(atMs);
    const take = scenario.takes.find((entry) => entry.id === step.take);
    if (take === undefined) {
      throw new ProtocolAdapterError(
        "trigger-unresolved",
        `script step ${index} names take "${step.take}", which the scenario does not carry`,
      );
    }
    const pcm = decodeWavPcm(readFileSync(take.path));
    state.spoken.push({ step: index, take: step.take, atMs: callTime() });
    await pump.say(pcm);
  }

  /** The next observed event of one type, in script order. */
  let cursor = -1;
  async function waitForEvent(
    type: "agent-speech-start" | "agent-turn-end" | "agent-speech-end",
  ): Promise<AgentTimelineEvent> {
    const deadline = callTime() + timeoutMs;
    for (;;) {
      noteQuiet();
      for (let index = cursor + 1; index < state.timeline.length; index += 1) {
        const event = state.timeline[index];
        if (event !== undefined && event.type === type) {
          cursor = index;
          return event;
        }
      }
      if (state.end !== null || state.closed || dropped) {
        throw new ProtocolAdapterError(
          "trigger-unresolved",
          `the call ended before the agent produced "${type}"; a trigger that never fires is not a skip`,
        );
      }
      if (callTime() > deadline) {
        throw new ProtocolAdapterError(
          "call-timeout",
          `no "${type}" event within ${timeoutMs} ms`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  try {
    for (const [index, step] of scenario.script.entries()) {
      await cue(step, index);
    }
  } catch (error) {
    running = false;
    pump.stop().catch(() => {});
    socket.close();
    await relay.catch(() => {});
    if (error instanceof ProtocolAdapterError) throw error;
    throw new ProtocolAdapterError(
      "trigger-unresolved",
      `the caller script failed: ${(error as Error).message}`,
    );
  }

  // The scenario's call-drop is evidence, not a harness failure: close at the
  // fault point and record the way the call ended.
  if (dropAt !== null && !dropped && state.end === null && !state.closed) {
    await waitUntil(dropAt).catch(() => {});
    // The pump may have dropped the call at the frame due at `dropAt`. Only
    // close here when the call reached the fault point without doing so; a
    // graceful end before the fault is not a drop.
    if (!dropped && state.end === null) {
      dropped = true;
      running = false;
      socket.close();
    }
  }

  // Wait for the service's graceful end. A call-drop or a close is an ending
  // too; the record names which.
  const endDeadline = callTime() + timeoutMs;
  while (running && state.end === null && !state.closed) {
    noteQuiet();
    if (callTime() > endDeadline) {
      state.error = `no end frame within ${timeoutMs} ms`;
      break;
    }
    await sleep(POLL_MS);
  }
  running = false;
  await pump.stop().catch(() => {});
  await relay.catch(() => {});

  noteQuiet();
  state.timeline.push({ atMs: callTime(), type: "call-end" });

  const plan = evaluateTriggers(scenario.script, state.timeline);
  try {
    assertTriggersResolved(plan);
  } catch (error) {
    throw new ProtocolAdapterError(
      "trigger-unresolved",
      `${(error as Error).message}`,
    );
  }

  const endedBy: ProtocolCallResult["endedBy"] = dropped
    ? "fault-call-drop"
    : state.end !== null
      ? "end"
      : state.endCallSeen
        ? "end_call"
        : state.closed
          ? "closed"
          : "timeout";

  const received = concat(state.received);
  const observed: ObservedTimeline = {
    events: state.timeline,
    spoken: state.spoken,
  };

  return {
    callId: call.callId,
    voice,
    subject,
    startedAt,
    endedAt: new Date().toISOString(),
    timeline: observed,
    triggerPlan: plan,
    faultsApplied: appliedFaults(scenario.faults, faultCounts),
    caller: {
      frames: state.capturedFrames,
      bytes: state.capturedBytes,
      frameBytes: INGRESS_FRAME_BYTES,
    },
    received: {
      pcm: received,
      sampleRate: INGRESS_SAMPLE_RATE,
      frames: state.receivedFrames,
      bytes: received.byteLength,
    },
    endedBy,
    error: state.error,
    tracePath: null,
    endPath: null,
  };
}

/** The transport's one target; exported for the runner's preflight. */
export type { ProtocolTarget };
