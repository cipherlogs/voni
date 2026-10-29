import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * Deterministic fake cascade service for the browser E2E seam (ticket 149).
 *
 * A real Chromium runs the real `CascadeSession`, mic path and playout worklet;
 * this module plays the service's part over Playwright's WebSocket routing.
 * The frames come from the committed script in
 * `tests/e2e/fixtures/cascade-call.json` (regenerate with
 * `scripts/make-cascade-e2e-fixture.mjs`): captions, base64 PCM at a stamped
 * rate, an `end_call`, and a clean close. The wire shapes follow
 * `voice-pipeline/transport.py`; the audio is a deterministic tone, not a
 * vendor recording. No vendor, no network, no clock.
 */

const FIXTURE_RELATIVE = "tests/e2e/fixtures/cascade-call.json";

/**
 * `import.meta` is unavailable in Playwright's CJS transform and `__dirname`
 * is unavailable under the tsx unit runner, so the committed fixture is found
 * from the process root: the app directory for both runners.
 */
function fixturePath(): string {
  for (const root of [process.cwd(), resolve(process.cwd(), "voni")]) {
    const path = resolve(root, FIXTURE_RELATIVE);
    if (existsSync(path)) return path;
  }
  throw new Error(`cannot find ${FIXTURE_RELATIVE} from ${process.cwd()}`);
}

export type ScriptedFrame = {
  /** Delay after the previous server frame, in milliseconds. */
  afterMs: number;
  frame: Record<string, unknown>;
};

export type ScriptedService = {
  schemaVersion: number;
  sampleRate: number;
  audioSeconds: number;
  frames: ScriptedFrame[];
};

export type ClientFrame = {
  at: number;
  type: string;
  [key: string]: unknown;
};

let cached: ScriptedService | null = null;

/** Load (and lightly validate) the committed scripted service. */
export function loadScriptedService(): ScriptedService {
  if (cached) return cached;
  const document = JSON.parse(readFileSync(fixturePath(), "utf8")) as Partial<ScriptedService>;
  if (document.schemaVersion !== 1) {
    throw new Error(`cascade-call.json is schemaVersion ${document.schemaVersion}, expected 1`);
  }
  if (typeof document.sampleRate !== "number" || !(document.sampleRate > 0)) {
    throw new Error("cascade-call.json has no positive sampleRate");
  }
  if (!Array.isArray(document.frames) || document.frames.length === 0) {
    throw new Error("cascade-call.json has no frames");
  }
  for (const [index, entry] of document.frames.entries()) {
    if (typeof entry?.frame?.type !== "string") {
      throw new Error(`cascade-call.json frame ${index} has no type`);
    }
  }
  cached = document as ScriptedService;
  return cached;
}

/** The negotiated audio format the scripted service stamps. */
export const FAKE_SAMPLE_RATE = loadScriptedService().sampleRate;

/** The recorded service half of one cascade call. */
export function recordedCall(): ScriptedFrame[] {
  return loadScriptedService().frames;
}

/** How much agent audio the script queued, computed from the fixture bytes. */
export function queuedAudioSeconds(script: ScriptedFrame[] = recordedCall()): number {
  const fallbackRate = loadScriptedService().sampleRate;
  return script
    .filter((entry) => entry.frame.type === "audio")
    .reduce((total, entry) => {
      const data = typeof entry.frame.data === "string" ? entry.frame.data : "";
      const rate = typeof entry.frame.sample_rate === "number" ? entry.frame.sample_rate : fallbackRate;
      return total + Buffer.from(data, "base64").length / 2 / rate;
    }, 0);
}

export type CascadeFake = {
  /** True once the browser opened the socket. */
  opened: () => boolean;
  /** The token-only config the client sent, if any. */
  config: () => Record<string, unknown> | null;
  /** Every non-audio client frame, in order, with arrival times. */
  frames: ClientFrame[];
  /** Audio frames the real mic path sent. */
  audioFrames: () => number;
  /** The `stop` frame's arrival, or null while the call is still up. */
  stopAt: () => number | null;
  /** Send one server frame. */
  say: (frame: Record<string, unknown>) => void;
  /** Replay the recorded call in order. */
  play: (script?: ScriptedFrame[]) => Promise<void>;
};

const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/** Intercept the cascade WebSocket and play the recorded service. */
export async function fakeCascadeServer(
  page: Page,
  script: ScriptedFrame[] = recordedCall(),
): Promise<CascadeFake> {
  const frames: ClientFrame[] = [];
  let audioFrames = 0;
  let config: Record<string, unknown> | null = null;
  let socket: WebSocketRoute | null = null;
  let stopAt: number | null = null;

  await page.routeWebSocket(/\/v1\/browser-call/, (route) => {
    socket = route;
    route.onMessage((raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof message.type === "string" ? message.type : "";
      if (type === "audio") {
        audioFrames += 1;
        return;
      }
      frames.push({ ...message, at: Date.now() } as ClientFrame);
      if (type === "config") config = message;
      if (type === "stop") stopAt = Date.now();
    });
  });

  return {
    opened: () => socket !== null,
    config: () => config,
    frames,
    audioFrames: () => audioFrames,
    stopAt: () => stopAt,
    say: (frame) => socket?.send(JSON.stringify(frame)),
    play: async (entries = script) => {
      for (const entry of entries) {
        if (entry.afterMs > 0) await wait(entry.afterMs);
        socket?.send(JSON.stringify(entry.frame));
      }
    },
  };
}
