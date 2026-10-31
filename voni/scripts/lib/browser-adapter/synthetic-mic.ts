/**
 * The synthetic microphone: the harness owns the mic before app code runs.
 *
 * The certifying adapter must never add a test branch to the production call
 * path. Instead it replaces `navigator.mediaDevices.getUserMedia` from a
 * Playwright init script — executed by the browser before any page script — and
 * returns a real `MediaStream` fed by Web Audio. The app then runs its ordinary
 * mic path (`acquireMicStream` → the audio graph → the caller's audio frames),
 * unaware that the stream came from a buffer rather than a device.
 *
 * A take is played into the stream on demand, so the scenario runtime can
 * schedule caller turns at the trigger points it resolved. The media faults the
 * scenario declares are applied at this same edge: a dropped chunk is a gap, a
 * jittered chunk waits, and neither is ever replayed. A denied permission and a
 * device switch are edge facts too, recorded so R5/R6 can be judged from what
 * the visitor's machine did. Nothing here knows a scenario, a verdict or an app
 * module.
 */

import type { Page } from "@playwright/test";

import type { Fault, FaultKind } from "@/lib/demo/verification/scenarios";

import type { AppliedFault } from "../protocol-adapter/types";

/** One caller take, already decoded from its committed WAV by the harness. */
export type SyntheticMicTake = {
  readonly id: string;
  /** PCM16 little-endian, mono, at `sampleRate`. */
  readonly pcmBase64: string;
  readonly sampleRate: number;
};

export type SyntheticMicPlay = {
  readonly id: string;
  /** Call-relative start on the microphone's own clock, in milliseconds. */
  readonly atMs: number;
  readonly durationMs: number;
  /**
   * Wall-clock start (epoch ms). The microphone's origin is its own audio
   * context, not the marks artifact's; this is the one field that ties caller
   * speech to the delivered audio and the browser marks.
   */
  readonly epochMs: number;
  /** Chunks the scenario's faults dropped; a gap, never a replay. */
  readonly droppedChunks: number;
  /** Chunks whose delivery was delayed by the scenario's jitter. */
  readonly delayedChunks: number;
};

/** What the harness asks the edge to do before the page opens. */
export type SyntheticMicOptions = {
  /** The scenario's media faults, applied to caller playback. */
  readonly faults?: readonly Fault[];
  /** Reject `getUserMedia` with `NotAllowedError`, the denial R5 measures. */
  readonly denyMicrophone?: boolean;
};

/** The shape the init script installs on the page. */
export type SyntheticMicPageApi = {
  readonly installedBeforeAppCode: true;
  readonly sampleRate: number;
  /** True once the app's `getUserMedia` was served the synthetic stream. */
  acquired(): boolean;
  /** True when a `getUserMedia` call has been made since the device switch. */
  reacquiredSinceSwitch(): boolean;
  /** True when the harness was configured to deny the microphone. */
  denied(): boolean;
  play(id: string, delayMs: number): Promise<SyntheticMicPlay>;
  played(): readonly SyntheticMicPlay[];
  /** Unplug the current input and offer a fresh one (R6). */
  switchDevice(): void;
};

/** Faults the synthetic mic can honour; the rest belong to the service. */
export const UPLINK_FAULT_KINDS: readonly FaultKind[] = [
  "audio-dropout",
  "network-jitter",
  "endpoint-latency",
];

/**
 * The bootstrap function. Kept as a function and serialized by Playwright, so
 * it cannot close over Node state or import an app module.
 */
function syntheticMicBootstrap(input: {
  takes: Record<string, { pcmBase64: string; sampleRate: number }>;
  faults: readonly { kind: string; atMs: number; durationMs?: number }[];
  denyMicrophone: boolean;
}): void {
  const CHUNK_MS = 20;
  const state: {
    ctx: AudioContext | null;
    bus: GainNode | null;
    keepAlive: ConstantSourceNode | null;
    destination: MediaStreamAudioDestinationNode | null;
    played: {
      id: string;
      atMs: number;
      durationMs: number;
      epochMs: number;
      droppedChunks: number;
      delayedChunks: number;
    }[];
    callOrigin: number;
    acquired: boolean;
    switched: boolean;
    reacquired: boolean;
  } = {
    ctx: null,
    bus: null,
    keepAlive: null,
    destination: null,
    played: [],
    callOrigin: 0,
    acquired: false,
    switched: false,
    reacquired: false,
  };

  const decode = (base64: string): Float32Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32768;
    }
    return samples;
  };

  const inWindow = (fault: { atMs: number; durationMs?: number }, atMs: number): boolean => {
    if (atMs < fault.atMs) return false;
    return atMs < fault.atMs + (fault.durationMs ?? CHUNK_MS);
  };

  /** The same deterministic shape the protocol adapter's seam applies. */
  const decisionFor = (
    atMs: number,
  ): { send: boolean; delayMs: number; kind: string | null } => {
    let delayMs = 0;
    let kind: string | null = null;
    for (const fault of input.faults) {
      if (!inWindow(fault, atMs)) continue;
      if (fault.kind === "audio-dropout") return { send: false, delayMs: 0, kind: fault.kind };
      if (fault.kind === "network-jitter") {
        const ceil = Math.max(1, fault.durationMs ?? 1);
        const candidate = (Math.floor(atMs / CHUNK_MS) % 4) * (ceil / 4);
        if (candidate > delayMs) {
          delayMs = candidate;
          kind = fault.kind;
        }
      }
      if (fault.kind === "endpoint-latency") {
        const candidate = Math.max(1, fault.durationMs ?? 1);
        if (candidate > delayMs) {
          delayMs = candidate;
          kind = fault.kind;
        }
      }
    }
    return { send: true, delayMs, kind };
  };

  const ensureContext = (): AudioContext => {
    if (state.ctx === null) {
      state.ctx = new AudioContext();
      state.bus = state.ctx.createGain();
      state.bus.gain.value = 1;
      state.keepAlive = state.ctx.createConstantSource();
      state.keepAlive.offset.value = 0;
      state.keepAlive.connect(state.bus);
      state.keepAlive.start();
      state.callOrigin = performance.now();
    }
    return state.ctx;
  };

  const freshDestination = (ctx: AudioContext): MediaStreamAudioDestinationNode => {
    if (state.destination !== null) {
      for (const track of state.destination.stream.getTracks()) track.stop();
      state.destination.disconnect();
    }
    const destination = ctx.createMediaStreamDestination();
    (state.bus as GainNode).connect(destination);
    state.destination = destination;
    return destination;
  };

  const origin = Date.now();
  Object.defineProperty(window, "__voniSyntheticMic", {
    configurable: false,
    value: {
      installedAt: origin,
      installedBeforeAppCode: true,
      acquired: () => state.acquired,
      reacquiredSinceSwitch: () => state.reacquired,
      denied: () => input.denyMicrophone,
      get sampleRate(): number {
        return state.ctx?.sampleRate ?? 0;
      },
      switchDevice: () => {
        state.switched = true;
        state.reacquired = false;
        if (state.ctx !== null) freshDestination(state.ctx);
        // A real unplug is a `devicechange` on the device list; the app owns
        // whether it reacquires or ends.
        try {
          navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
        } catch {
          /* a browser without the event still records the switch */
        }
      },
      play: async (id: string, delayMs: number) => {
        const take = input.takes[id];
        if (take === undefined) throw new Error(`unknown caller take "${id}"`);
        const ctx = ensureContext();
        await ctx.resume();
        const samples = decode(take.pcmBase64);
        const perChunk = Math.max(1, Math.round((CHUNK_MS / 1000) * take.sampleRate));
        const startAt = performance.now() - state.callOrigin + Math.max(0, delayMs);
        let droppedChunks = 0;
        let delayedChunks = 0;
        let cursor = 0;
        // Each chunk is scheduled once. A dropout never replays the chunk it
        // dropped, so the same caller sample can never be heard twice.
        for (let chunk = 0; cursor < samples.length; chunk += 1) {
          const chunkAtMs = startAt + chunk * CHUNK_MS;
          const decided = decisionFor(chunkAtMs);
          const length = Math.min(perChunk, samples.length - cursor);
          const slice = samples.subarray(cursor, cursor + length);
          cursor += length;
          if (!decided.send) {
            droppedChunks += 1;
            continue;
          }
          if (decided.delayMs > 0) delayedChunks += 1;
          const buffer = ctx.createBuffer(1, slice.length, take.sampleRate);
          buffer.getChannelData(0).set(slice);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(state.bus as GainNode);
          const when = ctx.currentTime + Math.max(0, delayMs + decided.delayMs) / 1000 +
            (chunk * CHUNK_MS) / 1000;
          source.start(when);
        }
        const play = {
          id,
          atMs: startAt,
          durationMs: (samples.length / take.sampleRate) * 1000,
          epochMs: Date.now() + Math.max(0, delayMs),
          droppedChunks,
          delayedChunks,
        };
        state.played.push(play);
        return play;
      },
      played: () => state.played,
    },
  });

  const media = navigator.mediaDevices;
  if (media === undefined) return;
  const original = media.getUserMedia.bind(media);
  Object.defineProperty(media, "getUserMedia", {
    configurable: true,
    value: async (constraints?: MediaStreamConstraints) => {
      if (!constraints || !constraints.audio) {
        return original(constraints);
      }
      if (input.denyMicrophone) {
        throw new DOMException("Permission denied", "NotAllowedError");
      }
      const ctx = ensureContext();
      await ctx.resume();
      if (state.switched) state.reacquired = true;
      state.acquired = true;
      // One destination per acquisition: the app stops its tracks on hang-up,
      // and a stopped destination cannot be revived for a second call.
      const destination = freshDestination(ctx);
      return destination.stream;
    },
  });
}

/** The source the browser runs; exported so the harness test can pin it. */
export function syntheticMicSource(
  takes: readonly SyntheticMicTake[],
  options: SyntheticMicOptions = {},
): string {
  const record: Record<string, { pcmBase64: string; sampleRate: number }> = {};
  for (const take of takes) {
    record[take.id] = { pcmBase64: take.pcmBase64, sampleRate: take.sampleRate };
  }
  const faults = (options.faults ?? []).filter((fault) =>
    (UPLINK_FAULT_KINDS as readonly string[]).includes(fault.kind),
  );
  return `(${syntheticMicBootstrap.toString()})(${JSON.stringify({
    takes: record,
    faults,
    denyMicrophone: options.denyMicrophone === true,
  })});`;
}

/**
 * Install the mic before the page's own scripts. The caller must invoke this
 * before `page.goto`; Playwright runs init scripts on every navigation before
 * app code.
 */
export async function installSyntheticMic(
  page: Page,
  takes: readonly SyntheticMicTake[],
  options: SyntheticMicOptions = {},
): Promise<void> {
  if (takes.length === 0) {
    throw new Error("the synthetic microphone needs at least one caller take");
  }
  await page.addInitScript({ content: syntheticMicSource(takes, options) });
}

/** The faults the mic actually saw, shaped like the run's applied-fault rows. */
export function micAppliedFaults(
  faults: readonly Fault[],
  played: readonly SyntheticMicPlay[],
): AppliedFault[] {
  return faults.map((fault) => {
    const drops = played.reduce((sum, play) => sum + play.droppedChunks, 0);
    const delays = played.reduce((sum, play) => sum + play.delayedChunks, 0);
    const observed =
      fault.kind === "audio-dropout"
        ? `${drops} caller chunk(s) dropped`
        : fault.kind === "call-drop"
          ? "the browser adapter has no call-drop edge; the fault was not applied"
          : `${delays} caller chunk(s) delayed`;
    return {
      kind: fault.kind,
      atMs: fault.atMs,
      ...(fault.durationMs === undefined ? {} : { durationMs: fault.durationMs }),
      observed,
    };
  });
}

/** Read the install/playback record after the call. */
export async function readSyntheticMicReport(page: Page): Promise<{
  readonly installedAt: number;
  readonly installedBeforeAppCode: boolean;
  readonly sampleRate: number | null;
  readonly played: readonly SyntheticMicPlay[];
  readonly reacquiredSinceSwitch: boolean;
  readonly denied: boolean;
}> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __voniSyntheticMic?: {
          installedAt: number;
          installedBeforeAppCode: boolean;
          sampleRate: number;
          played(): SyntheticMicPlay[];
          reacquiredSinceSwitch(): boolean;
          denied(): boolean;
        };
      }
    ).__voniSyntheticMic;
    if (api === undefined) throw new Error("the synthetic microphone was not installed");
    return {
      installedAt: api.installedAt,
      installedBeforeAppCode: api.installedBeforeAppCode,
      sampleRate: api.sampleRate > 0 ? api.sampleRate : null,
      played: api.played(),
      reacquiredSinceSwitch: api.reacquiredSinceSwitch(),
      denied: api.denied(),
    };
  }) as Promise<{
    installedAt: number;
    installedBeforeAppCode: boolean;
    sampleRate: number | null;
    played: readonly SyntheticMicPlay[];
    reacquiredSinceSwitch: boolean;
    denied: boolean;
  }>;
}

/** Convert one committed PCM16 WAV into the take the init script receives. */
export function pcm16ToBase64(pcm: Uint8Array): string {
  return Buffer.from(pcm).toString("base64");
}
