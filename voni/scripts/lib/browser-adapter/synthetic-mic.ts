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
 * schedule caller turns at the trigger points it resolved. Nothing here knows a
 * scenario, a verdict or an app module.
 */

import type { Page } from "@playwright/test";

/** One caller take, already decoded from its committed WAV by the harness. */
export type SyntheticMicTake = {
  readonly id: string;
  /** PCM16 little-endian, mono, at `sampleRate`. */
  readonly pcmBase64: string;
  readonly sampleRate: number;
};

export type SyntheticMicPlay = {
  readonly id: string;
  /** Call-relative start, in milliseconds. */
  readonly atMs: number;
  readonly durationMs: number;
};

/** The shape the init script installs on the page. */
export type SyntheticMicPageApi = {
  readonly installedBeforeAppCode: true;
  readonly sampleRate: number;
  play(id: string, delayMs: number): Promise<SyntheticMicPlay>;
  played(): readonly SyntheticMicPlay[];
};

/**
 * The bootstrap function. Kept as a function and serialized by Playwright, so
 * it cannot close over Node state or import an app module.
 */
function syntheticMicBootstrap(input: {
  takes: Record<string, { pcmBase64: string; sampleRate: number }>;
}): void {
  const state: {
    ctx: AudioContext | null;
    bus: GainNode | null;
    keepAlive: ConstantSourceNode | null;
    played: { id: string; atMs: number; durationMs: number }[];
    callOrigin: number;
  } = { ctx: null, bus: null, keepAlive: null, played: [], callOrigin: 0 };

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

  const origin = Date.now();
  Object.defineProperty(window, "__voniSyntheticMic", {
    configurable: false,
    value: {
      installedAt: origin,
      installedBeforeAppCode: true,
      get sampleRate(): number {
        return state.ctx?.sampleRate ?? 0;
      },
      play: async (id: string, delayMs: number) => {
        const take = input.takes[id];
        if (take === undefined) throw new Error(`unknown caller take "${id}"`);
        const ctx = ensureContext();
        await ctx.resume();
        const samples = decode(take.pcmBase64);
        const buffer = ctx.createBuffer(1, samples.length, take.sampleRate);
        buffer.getChannelData(0).set(samples);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(state.bus as GainNode);
        const delay = Math.max(0, delayMs) / 1000;
        source.start(ctx.currentTime + delay);
        const play = {
          id,
          atMs: performance.now() - state.callOrigin + Math.max(0, delayMs),
          durationMs: (samples.length / take.sampleRate) * 1000,
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
      const ctx = ensureContext();
      await ctx.resume();
      // One destination per call: the app stops its tracks on hang-up, and a
      // stopped destination cannot be revived for a second call.
      const destination = ctx.createMediaStreamDestination();
      (state.bus as GainNode).connect(destination);
      return destination.stream;
    },
  });
}

/** The source the browser runs; exported so the harness test can pin it. */
export function syntheticMicSource(takes: readonly SyntheticMicTake[]): string {
  const record: Record<string, { pcmBase64: string; sampleRate: number }> = {};
  for (const take of takes) {
    record[take.id] = { pcmBase64: take.pcmBase64, sampleRate: take.sampleRate };
  }
  return `(${syntheticMicBootstrap.toString()})(${JSON.stringify({ takes: record })});`;
}

/**
 * Install the mic before the page's own scripts. The caller must invoke this
 * before `page.goto`; Playwright runs init scripts on every navigation before
 * app code.
 */
export async function installSyntheticMic(
  page: Page,
  takes: readonly SyntheticMicTake[],
): Promise<void> {
  if (takes.length === 0) {
    throw new Error("the synthetic microphone needs at least one caller take");
  }
  await page.addInitScript({ content: syntheticMicSource(takes) });
}

/** Read the install/playback record after the call. */
export async function readSyntheticMicReport(page: Page): Promise<{
  readonly installedAt: number;
  readonly installedBeforeAppCode: boolean;
  readonly sampleRate: number | null;
  readonly played: readonly SyntheticMicPlay[];
}> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __voniSyntheticMic?: {
          installedAt: number;
          installedBeforeAppCode: boolean;
          sampleRate: number;
          played(): SyntheticMicPlay[];
        };
      }
    ).__voniSyntheticMic;
    if (api === undefined) throw new Error("the synthetic microphone was not installed");
    return {
      installedAt: api.installedAt,
      installedBeforeAppCode: api.installedBeforeAppCode,
      sampleRate: api.sampleRate > 0 ? api.sampleRate : null,
      played: api.played(),
    };
  }) as Promise<{
    installedAt: number;
    installedBeforeAppCode: boolean;
    sampleRate: number | null;
    played: readonly SyntheticMicPlay[];
  }>;
}

/** Convert one committed PCM16 WAV into the take the init script receives. */
export function pcm16ToBase64(pcm: Uint8Array): string {
  return Buffer.from(pcm).toString("base64");
}
