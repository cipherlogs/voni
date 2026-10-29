import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * Deterministic fake cascade service for the browser E2E seam (ticket 149,
 * extended by ticket 150).
 *
 * A real Chromium runs the real `CascadeSession`, mic path and playout worklet;
 * this module plays the service's part over Playwright's WebSocket routing.
 * The frames come from the committed script in
 * `tests/e2e/fixtures/cascade-call.json` (regenerate with
 * `scripts/make-cascade-e2e-fixture.mjs`): captions, numbered base64 PCM at a
 * stamped rate, a barge-in, a replayed frame, an `end_call`, and a clean
 * close. The wire shapes follow `voice-pipeline/transport.py`; the audio is a
 * deterministic tone, not a vendor recording. No vendor, no network, no clock.
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
  /**
   * The script's own labels, never sent on the wire. `hz` is the tone the
   * frame carries, `reply` which spoken reply it belongs to, and `duplicate`
   * marks a frame the service replayed on purpose.
   */
  reply?: string;
  hz?: number;
  duplicate?: boolean;
  frame: Record<string, unknown>;
};

export type ScriptedService = {
  schemaVersion: number;
  sampleRate: number;
  audioSeconds: number;
  interruptAfterMs: number;
  frames: ScriptedFrame[];
};

export type ClientFrame = {
  at: number;
  type: string;
  [key: string]: unknown;
};

/** One frame the fake sent, and when (epoch ms on this machine). */
export type SentFrame = { at: number; frame: Record<string, unknown> };

let cached: ScriptedService | null = null;

/**
 * Load (and lightly validate) the committed scripted service. A missing known
 * field is a fixture change and fails by name; an additive unknown field is
 * ignored, which is the fixture contract (spec: fixtures block every PR).
 */
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
    if (entry.frame.type === "audio") {
      const seq = entry.frame.seq;
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
        throw new Error(
          `cascade-call.json frame ${index} is audio with no call-level seq; ` +
            "the browser playout drops a frame that is not newer and needs the number",
        );
      }
      if (typeof entry.frame.sample_rate !== "number") {
        throw new Error(`cascade-call.json frame ${index} is audio with no sample_rate`);
      }
    }
  }
  cached = document as ScriptedService;
  return cached;
}

/** The source rate the scripted service stamped on every frame. */
export const FAKE_SAMPLE_RATE = loadScriptedService().sampleRate;

/** The recorded service half of one cascade call. */
export function recordedCall(): ScriptedFrame[] {
  return loadScriptedService().frames;
}

/** One audio frame's duration in seconds, at the rate it stamps. */
function frameSeconds(entry: ScriptedFrame): number {
  const data = typeof entry.frame.data === "string" ? entry.frame.data : "";
  const rate =
    typeof entry.frame.sample_rate === "number"
      ? entry.frame.sample_rate
      : loadScriptedService().sampleRate;
  return Buffer.from(data, "base64").length / 2 / rate;
}

/**
 * Audio the caller should hear once, by reply label: the script minus the
 * frames it replays. A playout that plays a duplicate makes this bound fail.
 */
export function replyAudioSeconds(
  reply: string,
  script: ScriptedFrame[] = recordedCall(),
): number {
  return script
    .filter((entry) => entry.frame.type === "audio" && entry.reply === reply && !entry.duplicate)
    .reduce((total, entry) => total + frameSeconds(entry), 0);
}

/** Unique audio in the whole script; duplicates count once, as the caller hears them. */
export function uniqueAudioSeconds(script: ScriptedFrame[] = recordedCall()): number {
  const firstSeq = new Set<number>();
  return script
    .filter((entry) => {
      if (entry.frame.type !== "audio" || entry.duplicate) return false;
      const seq = Number(entry.frame.seq);
      if (firstSeq.has(seq)) return false;
      firstSeq.add(seq);
      return true;
    })
    .reduce((total, entry) => total + frameSeconds(entry), 0);
}

/** The tone frequency a reply's frames carry, from the script's label. */
export function replyToneHz(reply: string, script: ScriptedFrame[] = recordedCall()): number {
  const entry = script.find(
    (candidate) => candidate.frame.type === "audio" && candidate.reply === reply && candidate.hz,
  );
  if (!entry || typeof entry.hz !== "number") {
    throw new Error(`cascade-call.json has no labelled tone for reply ${reply}`);
  }
  return entry.hz;
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
  /** Every server frame the fake sent, in order, with send times. */
  sent: SentFrame[];
  /** When the first audio frame hit the wire, or null before it did. */
  firstAudioAt: () => number | null;
  /** When the barge-in (`interrupted`) was sent, or null if the script has none. */
  interruptedAt: () => number | null;
  /** When `end_call` was sent, or null. */
  endCallAt: () => number | null;
  /** Send one server frame. */
  say: (frame: Record<string, unknown>) => void;
  /** Replay the recorded call in order, waiting the scripted delays. */
  play: (script?: ScriptedFrame[]) => Promise<void>;
};

const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/** Intercept the cascade WebSocket and play the recorded service. */
export async function fakeCascadeServer(
  page: Page,
  script: ScriptedFrame[] = recordedCall(),
): Promise<CascadeFake> {
  const frames: ClientFrame[] = [];
  const sent: SentFrame[] = [];
  let audioFrames = 0;
  let config: Record<string, unknown> | null = null;
  let socket: WebSocketRoute | null = null;
  let stopAt: number | null = null;

  const record = (frame: Record<string, unknown>) => {
    sent.push({ at: Date.now(), frame });
    socket?.send(JSON.stringify(frame));
  };

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

  const firstOf = (type: string) => sent.find((entry) => entry.frame.type === type)?.at ?? null;

  return {
    opened: () => socket !== null,
    config: () => config,
    frames,
    audioFrames: () => audioFrames,
    stopAt: () => stopAt,
    sent,
    firstAudioAt: () => firstOf("audio"),
    interruptedAt: () => firstOf("interrupted"),
    endCallAt: () => firstOf("end_call"),
    say: (frame) => record(frame),
    play: async (entries = script) => {
      for (const entry of entries) {
        if (entry.afterMs > 0) await wait(entry.afterMs);
        record(entry.frame);
      }
    },
  };
}
